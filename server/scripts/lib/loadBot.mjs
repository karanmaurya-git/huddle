// Bots that go through the REAL join flow of the app (REST, WebSocket, SFU token, SFU media).
// Shared by `npm run loadtest` (any server) and the SFU integration tests.
import WebSocket from 'ws';
import {
  Room, RoomEvent, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, AudioStream, AudioFrame,
} from '@livekit/rtc-node';

const SAMPLE_RATE = 48000;
const FRAME = 480; // 10 ms
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(apiUrl, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.message || ''}`.trim());
  return json;
}

export async function registerBot(apiUrl, name, suffix) {
  const email = `bot-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@load.test`;
  const r = await call(apiUrl, '/auth/register', { method: 'POST', body: { name, email, password: 'password123' } });
  return { token: r.token, userId: r.user.id, name };
}

export async function createMeeting(apiUrl, token) {
  return (await call(apiUrl, '/meetings', { method: 'POST', token, body: { title: 'Load test' } })).meeting.code;
}

export async function deleteMeeting(apiUrl, token, code) {
  await call(apiUrl, `/meetings/${code}`, { method: 'DELETE', token }).catch(() => {});
}

/** ticket -> WebSocket -> join_room. Resolves with the open socket and the room_joined payload. */
export async function joinOverWebSocket({ apiUrl, wsUrl, token, code }) {
  const { ticket } = await call(apiUrl, '/auth/ws-ticket', { method: 'POST', token, body: { roomId: code } });
  const ws = new WebSocket(`${wsUrl}?ticket=${ticket}`);
  const joined = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('join_room timed out')), 15000);
    ws.once('error', reject);
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'room_joined') { clearTimeout(timer); resolve(m.payload); }
      if (m.type === 'error') { clearTimeout(timer); reject(new Error(`${m.payload.code}: ${m.payload.message}`)); }
    });
    ws.once('open', () => ws.send(JSON.stringify({ type: 'join_room', payload: { roomId: code } })));
  });
  return { ws, joined };
}

/** Asks the app for an SFU token (members only) and connects a headless media participant. */
export async function connectMedia({ apiUrl, token, code, autoSubscribe = true }) {
  const { token: sfuToken, url } = await call(apiUrl, `/meetings/${code}/sfu-token`, { method: 'POST', token });
  const room = new Room();
  await room.connect(url, sfuToken, { autoSubscribe, dynacast: false });
  return room;
}

/** Publishes a 440 Hz tone as a microphone track until `stop()` is called. */
export async function publishTone(room) {
  const source = new AudioSource(SAMPLE_RATE, 1);
  const track = LocalAudioTrack.createAudioTrack('mic', source);
  await room.localParticipant.publishTrack(track, new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }));
  let running = true;
  let phase = 0;
  const loop = (async () => {
    while (running) {
      const data = new Int16Array(FRAME);
      for (let i = 0; i < FRAME; i += 1) { data[i] = Math.round(12000 * Math.sin(phase)); phase += (2 * Math.PI * 440) / SAMPLE_RATE; }
      await source.captureFrame(new AudioFrame(data, SAMPLE_RATE, 1, FRAME));
    }
  })().catch(() => {});
  return { stop: async () => { running = false; await loop; } };
}

/** Counts audio frames (and the loudest sample) received from other participants. */
export function countIncomingAudio(room) {
  const stats = { frames: 0, maxAmplitude: 0, tracks: 0 };
  room.on(RoomEvent.TrackSubscribed, async (track) => {
    stats.tracks += 1;
    for await (const frame of new AudioStream(track)) {
      stats.frames += 1;
      for (const s of frame.data) stats.maxAmplitude = Math.max(stats.maxAmplitude, Math.abs(s));
    }
  });
  return stats;
}

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** Runs `users` bots (1 host + users-1) through the real flow and reports what happened. */
export async function runLoad({ apiUrl, wsUrl, users, publishers = 3, holdMs = 4000, settleMs = 20000, concurrency = 5, log = () => {} }) {
  const startedAt = Date.now();
  const failures = [];
  const connectTimes = [];
  const bots = [];

  const host = await registerBot(apiUrl, 'Load Host', 'host');
  const code = await createMeeting(apiUrl, host.token);

  async function startBot(bot, index) {
    const t0 = Date.now();
    const { ws, joined } = await joinOverWebSocket({ apiUrl, wsUrl, token: bot.token, code });
    const room = await connectMedia({ apiUrl, token: bot.token, code });
    const incoming = countIncomingAudio(room);
    const tone = index < publishers ? await publishTone(room) : null;
    connectTimes.push(Date.now() - t0);
    bots.push({ ws, room, tone, incoming, joined, isPublisher: index < publishers });
  }

  const all = [host];
  for (let i = 1; i < users; i += 1) all.push(await registerBot(apiUrl, `Load Bot ${i}`, i));

  for (let i = 0; i < all.length; i += concurrency) {
    await Promise.all(
      all.slice(i, i + concurrency).map((bot, j) =>
        startBot(bot, i + j).catch((err) => failures.push(`${bot.name}: ${err.message}`))
      )
    );
    log(`started ${Math.min(i + concurrency, all.length)}/${all.length}`);
  }

  // Give late joiners time to receive their first audio, then keep everyone connected a bit.
  const listeners = bots.filter((b) => !b.isPublisher);
  const settleStart = Date.now();
  while (Date.now() - settleStart < settleMs && !listeners.every((b) => b.incoming.frames > 0)) await sleep(200);
  const settleMsUsed = Date.now() - settleStart;
  await sleep(holdMs);

  const receivedFrames = listeners.map((b) => b.incoming.frames);
  const seenRemotes = bots.map((b) => b.room.remoteParticipants.size);
  const report = {
    requestedUsers: users,
    connected: bots.length,
    failed: failures.length,
    failures: failures.slice(0, 5),
    publishers: bots.filter((b) => b.isPublisher).length,
    listenersReceivingAudio: receivedFrames.filter((f) => f > 0).length,
    listeners: listeners.length,
    minFramesPerListener: receivedFrames.length ? Math.min(...receivedFrames) : null,
    maxRemotesSeenByOneBot: seenRemotes.length ? Math.max(...seenRemotes) : 0,
    connectMs: { p50: percentile(connectTimes, 50), p95: percentile(connectTimes, 95), max: Math.max(0, ...connectTimes) },
    msUntilAllListenersHadAudio: settleMsUsed,
    totalSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };

  for (const b of bots) await b.tone?.stop();
  await Promise.allSettled(bots.map((b) => b.room.disconnect()));
  bots.forEach((b) => b.ws.close());
  await deleteMeeting(apiUrl, host.token, code);
  return report;
}
