import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { TicketService } from '../src/services/ticketService.js';
import { createMeetingLifecycle } from '../src/services/meetingLifecycle.js';
import { RoomManager } from '../src/websocket/RoomManager.js';
import { FakeSfu } from './helpers/fakeSfu.js';
import { getFakeMeeting } from './helpers/fakeModels.js';

let app;
let roomManager;
let ticketService;
let sfu;

beforeAll(() => {
  sfu = new FakeSfu();
  ticketService = new TicketService();
  roomManager = new RoomManager({ sfu });
  app = createApp({ roomManager, ticketService, sfu, lifecycle: createMeetingLifecycle({ roomManager, sfu }) });
});
afterAll(() => {
  roomManager.shutdown();
  ticketService.close();
});

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const credentials = { name: 'Karan', email: 'karan@test.dev', password: 'password123' };
const fakeWs = () => ({ readyState: 1, send() {}, close() {} });
const register = async (email, name = 'User') =>
  (await request(app).post('/api/auth/register').send({ name, email, password: 'password123' })).body;

describe('health', () => {
  it('GET /api/health returns 200', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Server is running' });
  });
});

describe('auth', () => {
  it('registers a user, hashes the password, and returns a JWT', async () => {
    const res = await request(app).post('/api/auth/register').send(credentials);
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toEqual({ id: expect.any(String), name: 'Karan', email: 'karan@test.dev' });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    expect(jwt.decode(res.body.token).sub).toBe(res.body.user.id); // token holds only the user id

    const { findUserByEmail } = await import('../src/services/userService.js');
    const stored = await findUserByEmail('karan@test.dev');
    expect(stored.passwordHash).not.toBe(credentials.password);
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/); // bcrypt
  });

  it('rejects a duplicate email (409) and invalid input (400)', async () => {
    expect((await request(app).post('/api/auth/register').send(credentials)).status).toBe(409);
    expect((await request(app).post('/api/auth/register').send({ ...credentials, email: 'nope' })).status).toBe(400);
    expect((await request(app).post('/api/auth/register').send({ ...credentials, email: 'a@b.co', password: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/auth/register').send({ ...credentials, email: 'c@d.co', name: 'K' })).status).toBe(400);
  });

  it('logs in with the right password and rejects wrong password or unknown email with the same message', async () => {
    const ok = await request(app).post('/api/auth/login').send({ email: credentials.email, password: credentials.password });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    const wrong = await request(app).post('/api/auth/login').send({ email: credentials.email, password: 'wrong-password' });
    const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@test.dev', password: 'password123' });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('logout responds ok', async () => {
    expect((await request(app).post('/api/auth/logout')).body.success).toBe(true);
  });
});

describe('meetings', () => {
  let token;
  let userId;
  beforeAll(async () => {
    const r = await request(app).post('/api/auth/login').send({ email: credentials.email, password: credentials.password });
    token = r.body.token;
    userId = r.body.user.id;
  });

  it('requires a valid token on protected routes', async () => {
    expect((await request(app).get('/api/meetings')).status).toBe(401);
    expect((await request(app).post('/api/meetings')).status).toBe(401);
    expect((await request(app).post('/api/auth/ws-ticket').send({ roomId: 'ABC234' })).status).toBe(401);
    expect((await request(app).post('/api/meetings/ABC234/sfu-token')).status).toBe(401);
    expect((await request(app).get('/api/meetings').set('Authorization', 'Bearer junk')).status).toBe(401);
  });

  it('creates a meeting with a unique readable code, a title, and the creator as host', async () => {
    const a = await request(app).post('/api/meetings').set(auth(token)).send({ title: 'Standup' });
    const b = await request(app).post('/api/meetings').set(auth(token)).send({});
    expect(a.status).toBe(201);
    expect(a.body.meeting.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(a.body.meeting.code).not.toBe(b.body.meeting.code);
    expect(getFakeMeeting(a.body.meeting.code)).toMatchObject({ hostId: userId, title: 'Standup', status: 'active', maxParticipants: 100 });
    expect((await request(app).post('/api/meetings').set(auth(token)).send({ title: 'x'.repeat(81) })).status).toBe(400);
  });

  it('looks up a meeting and lists recent meetings', async () => {
    const created = await request(app).post('/api/meetings').set(auth(token)).send({ title: 'Lookup' });
    const code = created.body.meeting.code;
    const got = await request(app).get(`/api/meetings/${code}`).set(auth(token));
    expect(got.status).toBe(200);
    expect(got.body.meeting).toMatchObject({ code, title: 'Lookup', status: 'active', locked: false, count: 0, capacity: 100, isHost: true });
    expect((await request(app).get('/api/meetings/ZZZZZ9').set(auth(token))).status).toBe(404);
    expect((await request(app).get('/api/meetings/bad').set(auth(token))).status).toBe(400);

    const list = await request(app).get('/api/meetings').set(auth(token));
    const row = list.body.meetings.find((m) => m.code === code);
    expect(row).toMatchObject({ title: 'Lookup', status: 'active', isHost: true });
  });

  it('only the current host can delete a meeting, and it disappears everywhere', async () => {
    const other = (await register('other@test.dev', 'Other')).token;
    const code = (await request(app).post('/api/meetings').set(auth(token)).send({})).body.meeting.code;

    expect((await request(app).delete(`/api/meetings/${code}`)).status).toBe(401);
    expect((await request(app).delete('/api/meetings/bad').set(auth(token))).status).toBe(400);
    expect((await request(app).delete('/api/meetings/ZZZZZ9').set(auth(token))).status).toBe(404);
    expect((await request(app).delete(`/api/meetings/${code}`).set(auth(other))).status).toBe(403);
    expect((await request(app).get(`/api/meetings/${code}`).set(auth(token))).status).toBe(200);

    expect((await request(app).delete(`/api/meetings/${code}`).set(auth(token))).status).toBe(200);
    expect((await request(app).get(`/api/meetings/${code}`).set(auth(token))).status).toBe(404);
    expect(roomManager.getRoom(code)).toBeUndefined();
    expect(sfu.callsOf('deleteRoom').some((c) => c.args[0] === code)).toBe(true);
    const list = await request(app).get('/api/meetings').set(auth(token));
    expect(list.body.meetings.some((m) => m.code === code)).toBe(false);
  });

  it('issues a ws-ticket only for existing, running meetings', async () => {
    const code = (await request(app).post('/api/meetings').set(auth(token)).send({})).body.meeting.code;
    const ok = await request(app).post('/api/auth/ws-ticket').set(auth(token)).send({ roomId: code });
    expect(ok.status).toBe(200);
    expect(ok.body.ticket).toMatch(/^[a-f0-9]{48}$/);
    expect((await request(app).post('/api/auth/ws-ticket').set(auth(token)).send({ roomId: 'ZZZZZ9' })).status).toBe(404);
    expect((await request(app).post('/api/auth/ws-ticket').set(auth(token)).send({ roomId: 'x' })).status).toBe(400);
  });
});

describe('SFU token gatekeeping', () => {
  let hostToken;
  let hostId;
  let code;
  beforeAll(async () => {
    const h = await register('sfu-host@test.dev', 'Hostess');
    hostToken = h.token;
    hostId = h.user.id;
    code = (await request(app).post('/api/meetings').set(auth(hostToken)).send({})).body.meeting.code;
  });

  it('refuses a token to someone who has not joined the meeting', async () => {
    const res = await request(app).post(`/api/meetings/${code}/sfu-token`).set(auth(hostToken));
    expect(res.status).toBe(403); // logged in, host, but not joined over the WebSocket yet
  });

  it('issues a token to a current member with the server-decided identity and role', async () => {
    roomManager.getRoom(code).join({ userId: hostId, username: 'Hostess', ws: fakeWs() });
    const res = await request(app).post(`/api/meetings/${code}/sfu-token`).set(auth(hostToken));
    expect(res.status).toBe(200);
    expect(res.body.url).toBe('ws://sfu.test');
    const claims = jwt.decode(res.body.token);
    expect(claims.sub).toBe(hostId);
    expect(JSON.parse(claims.metadata)).toEqual({ role: 'host' });
    expect(claims.video.room).toBe(code);
    expect(claims.video.roomAdmin).toBeFalsy();
    expect(sfu.callsOf('ensureRoom').some((c) => c.args[0] === code)).toBe(true);
  });

  it('refuses non-members, removed users, locked-out newcomers and ended meetings', async () => {
    const stranger = (await register('stranger@test.dev')).token;
    expect((await request(app).post(`/api/meetings/${code}/sfu-token`).set(auth(stranger))).status).toBe(403);

    const room = roomManager.getRoom(code);
    const bob = await register('bob-sfu@test.dev', 'Bob');
    room.join({ userId: bob.user.id, username: 'Bob', ws: fakeWs() });
    expect((await request(app).post(`/api/meetings/${code}/sfu-token`).set(auth(bob.token))).status).toBe(200);
    room.kick(bob.user.id);
    expect((await request(app).post(`/api/meetings/${code}/sfu-token`).set(auth(bob.token))).status).toBe(403);

    room.setLocked(true);
    const late = (await register('late-sfu@test.dev')).token;
    expect((await request(app).post(`/api/meetings/${code}/sfu-token`).set(auth(late))).status).toBe(403);

    await request(app).delete(`/api/meetings/${code}`).set(auth(hostToken));
    expect((await request(app).post(`/api/meetings/${code}/sfu-token`).set(auth(hostToken))).status).toBe(403);
  });

  it('explains WHY the media server failed (not running vs. wrong credentials) outside production', async () => {
    const h = await register('why-host@test.dev');
    const c = (await request(app).post('/api/meetings').set(auth(h.token)).send({})).body.meeting.code;
    roomManager.getRoom(c).join({ userId: h.user.id, username: 'H', ws: fakeWs() });

    const down = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    sfu.failing.add('ensureRoom');
    sfu.errors.set('ensureRoom', down);
    const notRunning = await request(app).post(`/api/meetings/${c}/sfu-token`).set(auth(h.token));
    expect(notRunning.status).toBe(503);
    expect(notRunning.body.code).toBe('SFU_UNAVAILABLE');
    expect(notRunning.body.message).toMatch(/Cannot reach the LiveKit media server/);

    sfu.errors.set('ensureRoom', Object.assign(new Error('invalid API key'), { name: 'Unauthorized', status: 401 }));
    const wrongKey = await request(app).post(`/api/meetings/${c}/sfu-token`).set(auth(h.token));
    expect(wrongKey.body.message).toMatch(/LIVEKIT_API_KEY/);
    sfu.failing.delete('ensureRoom');
    sfu.errors.clear();
  });

  it('returns 503 with a clear code when the media server is down', async () => {
    const h = await register('down-host@test.dev');
    const c = (await request(app).post('/api/meetings').set(auth(h.token)).send({})).body.meeting.code;
    roomManager.getRoom(c).join({ userId: h.user.id, username: 'H', ws: fakeWs() });
    sfu.failing.add('ensureRoom');
    const res = await request(app).post(`/api/meetings/${c}/sfu-token`).set(auth(h.token));
    sfu.failing.delete('ensureRoom');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('SFU_UNAVAILABLE');
  });
});

describe('media health endpoint', () => {
  it('reports reachable, or unreachable with the reason and a hint', async () => {
    const ok = await request(app).get('/api/health/media');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, sfu: 'reachable' });

    sfu.healthResult = { ok: false, reason: 'unreachable', hint: 'Start LiveKit.' };
    const down = await request(app).get('/api/health/media');
    sfu.healthResult = { ok: true };
    expect(down.status).toBe(503);
    expect(down.body).toEqual({ success: false, sfu: 'unreachable', reason: 'unreachable', hint: 'Start LiveKit.' });
  });
  it('keeps the original health response unchanged', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ success: true, message: 'Server is running' });
  });
});

describe('SFU webhook', () => {
  it('rejects an invalid signature and processes a valid event idempotently', async () => {
    const h = await register('hook-host@test.dev');
    const code = (await request(app).post('/api/meetings').set(auth(h.token)).send({})).body.meeting.code;
    const room = roomManager.getRoom(code);
    room.join({ userId: h.user.id, username: 'H', ws: fakeWs() });
    room.requestShare(h.user.id);

    const body = JSON.stringify({ type: 'track_unpublished', room: code, identity: h.user.id, trackSource: 'SCREEN_SHARE' });
    const bad = await request(app).post('/api/sfu/webhook').set('Authorization', 'forged').set('Content-Type', 'application/webhook+json').send(body);
    expect(bad.status).toBe(401);
    expect(room.presenterId).toBe(h.user.id);

    for (let i = 0; i < 2; i += 1) {
      const ok = await request(app).post('/api/sfu/webhook').set('Authorization', 'valid').set('Content-Type', 'application/webhook+json').send(body);
      expect(ok.status).toBe(200);
    }
    expect(room.presenterId).toBeNull();
  });
});

describe('security headers and CORS', () => {
  it('sets Helmet headers and blocks unknown browser origins', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const blocked = await request(app).get('/api/health').set('Origin', 'https://evil.example');
    expect(blocked.status).toBe(403);
    const allowed = await request(app).get('/api/health').set('Origin', 'http://localhost:5173');
    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('answers malformed JSON with 400 and unknown routes with 404', async () => {
    const bad = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{oops');
    expect(bad.status).toBe(400);
    expect((await request(app).get('/api/nothing')).status).toBe(404);
  });
});

