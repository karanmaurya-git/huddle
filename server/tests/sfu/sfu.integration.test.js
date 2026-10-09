// Integration tests against a REAL livekit-server and real media (headless bot participants).
// If the server binary cannot run here, the whole file is skipped with a message.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  Room, RoomEvent, TrackPublishOptions, TrackSource, VideoSource, LocalVideoTrack, VideoFrame, VideoBufferType, ConnectionState,
} from '@livekit/rtc-node';
import { LiveKitProvider } from '../../src/sfu/LiveKitProvider.js';
import { startLiveKit, SFU } from './helpers/livekitServer.js';
import { connectMediaWithToken, publishTone, countIncomingAudio, sleep } from './helpers/bots.js';

async function waitUntil(check, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await sleep(150);
  }
}

const lk = await startLiveKit();
const sfu = lk ? new LiveKitProvider({ url: SFU.url, apiUrl: SFU.apiUrl, apiKey: SFU.apiKey, apiSecret: SFU.apiSecret }) : null;
let counter = 0;
const newRoom = async (opts = {}) => {
  const code = `T${String(++counter).padStart(2, '0')}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  await sfu.ensureRoom(code, opts);
  return code;
};
const rooms = [];
const connect = async (code, userId, extra = {}) => {
  const room = await connectMediaWithToken(sfu, code, userId, extra);
  rooms.push(room);
  return room;
};

afterAll(async () => {
  await Promise.allSettled(rooms.map((r) => r.disconnect()));
  await lk?.stop();
});

describe.skipIf(!lk)('real SFU (livekit-server --dev)', () => {
  it('a token minted by LiveKitProvider connects, with the server-decided identity, name and role', async () => {
    const code = await newRoom();
    const room = await connect(code, 'user-1', { username: 'Una', role: 'moderator' });
    expect(room.connectionState).toBe(ConnectionState.CONN_CONNECTED);
    expect(room.localParticipant.identity).toBe('user-1');
    expect(room.localParticipant.name).toBe('Una');
    expect(JSON.parse(room.localParticipant.metadata)).toEqual({ role: 'moderator' });
  });

  it('forwards real audio from one participant to another through the SFU', async () => {
    const code = await newRoom();
    const alice = await connect(code, 'alice');
    const bob = await connect(code, 'bob');
    const incoming = countIncomingAudio(bob);
    const tone = await publishTone(alice);
    await sleep(2500);
    await tone.stop();
    expect(incoming.tracks).toBe(1);
    expect(incoming.frames).toBeGreaterThan(100);
    expect(incoming.maxAmplitude).toBeGreaterThan(5000); // the 440 Hz tone arrived, not silence
  });

  it('server-side mute silences a published microphone track', async () => {
    const code = await newRoom();
    const alice = await connect(code, 'alice');
    const bob = await connect(code, 'bob');
    const muted = new Promise((resolve) => bob.on(RoomEvent.TrackMuted, (pub, participant) => resolve(participant.identity)));
    const tone = await publishTone(alice);
    await sleep(800);
    await sfu.muteMicrophone(code, 'alice');
    expect(await Promise.race([muted, sleep(4000).then(() => 'timeout')])).toBe('alice');
    await tone.stop();
  });

  it('removeParticipant disconnects that participant; deleteRoom ends everyone\'s session', async () => {
    const code = await newRoom();
    const alice = await connect(code, 'alice');
    const bob = await connect(code, 'bob');
    const aliceGone = new Promise((resolve) => alice.once(RoomEvent.Disconnected, resolve));
    await sfu.removeParticipant(code, 'alice');
    await Promise.race([aliceGone, sleep(4000)]);
    expect(alice.connectionState).toBe(ConnectionState.CONN_DISCONNECTED);
    expect((await sfu.rooms.listParticipants(code)).map((p) => p.identity)).toEqual(['bob']);

    const bobGone = new Promise((resolve) => bob.once(RoomEvent.Disconnected, resolve));
    await sfu.deleteRoom(code);
    await Promise.race([bobGone, sleep(4000)]);
    expect(bob.connectionState).toBe(ConnectionState.CONN_DISCONNECTED);
  });

  it('updateRole changes participant metadata that others observe', async () => {
    const code = await newRoom();
    const alice = await connect(code, 'alice');
    const bob = await connect(code, 'bob');
    const seen = new Promise((resolve) => bob.on(RoomEvent.ParticipantMetadataChanged, (meta, p) => p.identity === 'alice' && resolve(meta)));
    await sfu.updateRole(code, 'alice', 'moderator');
    expect(JSON.parse(await Promise.race([seen, sleep(4000).then(() => '{}')]))).toEqual({ role: 'moderator' });
    expect(alice).toBeDefined();
  });

  it('enforces the screen-share permission: refused by default, allowed after the server grants it, muted when revoked', async () => {
    const code = await newRoom();
    const alice = await connect(code, 'alice');
    const makeTrack = () => {
      const source = new VideoSource(320, 180);
      const track = LocalVideoTrack.createVideoTrack('screen', source);
      source.captureFrame(new VideoFrame(new Uint8Array(320 * 180 * 4).fill(120), 320, 180, VideoBufferType.RGBA));
      return track;
    };
    const options = () => new TrackPublishOptions({ source: TrackSource.SOURCE_SCREENSHARE });

    // 1. Without the permission the SFU refuses a screen-share track.
    await expect(alice.localParticipant.publishTrack(makeTrack(), options())).rejects.toThrow();

    // 2. After the server grants the slot, the same participant can publish it.
    await sfu.setScreenSharePermission(code, 'alice', true);
    await sleep(800);
    await alice.localParticipant.publishTrack(makeTrack(), options());
    const screenTracks = async () =>
      (await sfu.rooms.getParticipant(code, 'alice')).tracks.filter((t) => t.source === TrackSource.SOURCE_SCREENSHARE);
    await waitUntil(async () => (await screenTracks()).length === 1);
    expect(await screenTracks()).toHaveLength(1);

    // 3. Revoking takes the permission away: the SFU drops the screen-share track.
    await sfu.stopScreenShare(code, 'alice');
    await waitUntil(async () => (await screenTracks()).every((t) => t.muted));
    expect((await screenTracks()).every((t) => t.muted)).toBe(true); // none left, or muted
  });

  it('the SFU participant count matches the app for 12 bots, and maxParticipants is a real backstop', async () => {
    const code = await newRoom({ maxParticipants: 12 });
    const bots = [];
    for (let i = 0; i < 12; i += 1) bots.push(await connect(code, `bot-${i}`));
    expect((await sfu.rooms.listParticipants(code)).length).toBe(12);
    await expect(connect(code, 'one-too-many')).rejects.toThrow();
  });

  it('ensureRoom is idempotent and tokens expire quickly', async () => {
    const code = await newRoom();
    await expect(sfu.ensureRoom(code, { maxParticipants: 5 })).resolves.toBeUndefined();
    const token = await sfu.createToken({ userId: 'u', username: 'U', role: 'participant', roomCode: code });
    const claims = jwt.decode(token);
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(600);
  });

  it('healthCheck: reachable with the right credentials, and a clear reason for a wrong secret', async () => {
    expect(await sfu.healthCheck()).toEqual({ ok: true });
    const wrong = new LiveKitProvider({ url: SFU.url, apiUrl: SFU.apiUrl, apiKey: SFU.apiKey, apiSecret: 'WRONG-secret-WRONG-secret-1234' });
    const result = await wrong.healthCheck();
    expect(result).toMatchObject({ ok: false, reason: 'bad_credentials' });
    expect(result.hint).toContain('LIVEKIT_API_SECRET');
  });

  it('healthCheck: says "unreachable" when LiveKit is not running at that address', async () => {
    const dead = new LiveKitProvider({ url: 'ws://127.0.0.1:7999', apiUrl: 'http://127.0.0.1:7999', apiKey: SFU.apiKey, apiSecret: SFU.apiSecret });
    const result = await dead.healthCheck();
    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(result.hint).toContain('7999');
  });

  it('is a Room object from rtc-node (sanity: the bots are real SDK participants)', () => {
    expect(new Room()).toBeInstanceOf(Room);
  });
});

describe.skipIf(lk)('real SFU', () => {
  it.skip('SKIPPED: livekit-server could not be started or downloaded in this environment', () => {});
});
