import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { TrackSource } from 'livekit-server-sdk';
import { TicketService } from '../src/services/ticketService.js';
import { generateRoomCode, normalizeRoomCode } from '../src/utils/roomCode.js';
import { RateLimiter } from '../src/utils/rateLimiter.js';
import { ROLES, ACTIONS, can, canModerate } from '../src/websocket/constants.js';
import { Room } from '../src/websocket/Room.js';
import { FakeSfu } from './helpers/fakeSfu.js';
import { permissionFor, describeSfuError } from '../src/sfu/LiveKitProvider.js';
import { handleSfuEvent } from '../src/websocket/sfuEvents.js';

const fakeWs = () => ({ readyState: 1, sent: [], send(d) { this.sent.push(JSON.parse(d)); }, close: vi.fn() });
const rooms = [];
const makeRoom = (o = {}) => {
  const room = new Room({ roomId: 'ABC234', hostId: 'host', maxParticipants: 100, options: { disconnectGraceMs: 30 }, ...o });
  rooms.push(room);
  return room;
};
const join = (room, id) => room.join({ userId: id, username: id.toUpperCase(), ws: fakeWs() });
afterEach(() => rooms.splice(0).forEach((r) => r.destroy()));

describe('permission matrix', () => {
  it('Host can do everything; Participant only chat, hand and share', () => {
    for (const a of Object.values(ACTIONS)) expect(can(ROLES.HOST, a)).toBe(true);
    expect(can(ROLES.PARTICIPANT, ACTIONS.CHAT)).toBe(true);
    expect(can(ROLES.PARTICIPANT, ACTIONS.RAISE_HAND)).toBe(true);
    expect(can(ROLES.PARTICIPANT, ACTIONS.SHARE_SCREEN)).toBe(true);
    for (const a of [ACTIONS.MODERATE, ACTIONS.REMOVE_PARTICIPANT, ACTIONS.ASSIGN_ROLE, ACTIONS.TRANSFER_HOST, ACTIONS.LOCK_ROOM, ACTIONS.END_MEETING]) {
      expect(can(ROLES.PARTICIPANT, a)).toBe(false);
    }
  });
  it('Moderator can moderate and remove but not assign roles, transfer, lock or end', () => {
    expect(can(ROLES.MODERATOR, ACTIONS.MODERATE)).toBe(true);
    expect(can(ROLES.MODERATOR, ACTIONS.REMOVE_PARTICIPANT)).toBe(true);
    for (const a of [ACTIONS.ASSIGN_ROLE, ACTIONS.TRANSFER_HOST, ACTIONS.LOCK_ROOM, ACTIONS.END_MEETING]) {
      expect(can(ROLES.MODERATOR, a)).toBe(false);
    }
  });
  it('canModerate: Host acts on anyone but self; Moderator only on Participants', () => {
    const host = { userId: 'h', role: ROLES.HOST };
    const mod = { userId: 'm', role: ROLES.MODERATOR };
    const mod2 = { userId: 'm2', role: ROLES.MODERATOR };
    const p = { userId: 'p', role: ROLES.PARTICIPANT };
    expect(canModerate(host, mod)).toBe(true);
    expect(canModerate(host, p)).toBe(true);
    expect(canModerate(host, host)).toBe(false);
    expect(canModerate(mod, p)).toBe(true);
    expect(canModerate(mod, host)).toBe(false);
    expect(canModerate(mod, mod2)).toBe(false);
    expect(canModerate(p, p)).toBe(false);
    expect(canModerate(p, { userId: 'q', role: ROLES.PARTICIPANT })).toBe(false);
  });
});

describe('TicketService', () => {
  it('is single use, bound to user and room, and expires', () => {
    const t = new TicketService(50);
    const ticket = t.issue({ userId: 'u1', username: 'U', roomId: 'ABC234' });
    expect(t.consume(ticket)).toMatchObject({ userId: 'u1', roomId: 'ABC234' });
    expect(t.consume(ticket)).toBeNull(); // used
    const old = t.issue({ userId: 'u1', username: 'U', roomId: 'ABC234' });
    t.tickets.get(old).expiresAt = Date.now() - 1;
    expect(t.consume(old)).toBeNull(); // expired
    expect(t.consume('nope')).toBeNull();
    expect(t.consume(undefined)).toBeNull();
    t.close();
  });
});

describe('meeting codes and rate limiter', () => {
  it('generates readable 6-character codes and normalizes input', () => {
    for (let i = 0; i < 200; i += 1) expect(generateRoomCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(normalizeRoomCode(' abc234 ')).toBe('ABC234');
    expect(normalizeRoomCode('abc')).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
    expect(normalizeRoomCode('ABC23!')).toBeNull();
  });
  it('allows N hits per window', () => {
    const r = new RateLimiter(2, 1000);
    expect([r.allow(0), r.allow(1), r.allow(2), r.allow(1500)]).toEqual([true, true, false, true]);
  });
});

describe('SFU token grants', () => {
  const decode = async (opts) => {
    const sfu = new FakeSfu();
    const token = await sfu.createToken({ userId: 'u1', username: 'Una', role: 'participant', roomCode: 'ABC234', ...opts });
    return jwt.decode(token);
  };

  it('binds identity, name, room and a short TTL; role metadata is set by the server', async () => {
    const claims = await decode({ role: 'moderator' });
    expect(claims.sub).toBe('u1');
    expect(claims.name).toBe('Una');
    expect(JSON.parse(claims.metadata)).toEqual({ role: 'moderator' });
    expect(claims.video.room).toBe('ABC234');
    expect(claims.video.roomJoin).toBe(true);
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(600);
  });
  it('never grants admin permissions or data publishing, and withholds screen share by default', async () => {
    for (const role of ['host', 'moderator', 'participant']) {
      const { video } = await decode({ role });
      expect(video.roomAdmin).toBeFalsy();
      expect(video.roomCreate).toBeFalsy();
      expect(video.roomList).toBeFalsy();
      expect(video.roomRecord).toBeFalsy();
      expect(video.canPublishData).toBe(false);
      expect(video.canSubscribe).toBe(true);
      expect(video.canPublishSources).toEqual([TrackSource.CAMERA, TrackSource.MICROPHONE].map((s) => TrackSource[s].toLowerCase()));
    }
  });
  it('adds screen-share sources only when the slot is granted', () => {
    expect(permissionFor({ canShare: true }).canPublishSources).toContain(TrackSource.SCREEN_SHARE);
    expect(permissionFor({ canShare: false }).canPublishSources).not.toContain(TrackSource.SCREEN_SHARE);
  });
});

describe('SFU error classification (shapes captured from the real SDK)', () => {
  const fetchFailed = (code, message) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(message), { code }) });

  it('says the media server is unreachable when LiveKit is not running or the host is wrong', () => {
    for (const err of [fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:7880'), fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND nope'), new TypeError('fetch failed')]) {
      const result = describeSfuError(err, 'http://127.0.0.1:7880');
      expect(result.reason).toBe('unreachable');
      expect(result.hint).toContain('http://127.0.0.1:7880');
      expect(result.hint).toContain('livekit-server --dev');
    }
  });
  it('says the credentials were rejected for a 401 Unauthorized', () => {
    const wrongSecret = Object.assign(new Error('invalid authorization token: token signature is invalid'), { name: 'Unauthorized', status: 401 });
    const wrongKey = Object.assign(new Error('invalid API key'), { name: 'Unauthorized', status: 401 });
    for (const err of [wrongSecret, wrongKey]) {
      const result = describeSfuError(err);
      expect(result.reason).toBe('bad_credentials');
      expect(result.hint).toContain('LIVEKIT_API_KEY');
    }
  });
  it('falls back to a generic reason and never throws on odd input', () => {
    expect(describeSfuError(new Error('boom')).reason).toBe('other');
    expect(describeSfuError(undefined).reason).toBe('other');
    expect(describeSfuError(null).hint).toContain('unknown error');
  });
});

describe('Room capacity', () => {
  it('rejects a join when full, but a reconnecting member does not need a second seat', () => {
    const room = makeRoom({ maxParticipants: 2 });
    expect(join(room, 'host').participant.role).toBe(ROLES.HOST);
    expect(join(room, 'a').participant.role).toBe(ROLES.PARTICIPANT);
    expect(join(room, 'b').error).toBe('ROOM_FULL');
    expect(join(room, 'a').reconnected).toBe(true);
    expect(room.count).toBe(2);
  });
  it('rejects new joiners when locked but lets members back in', () => {
    const room = makeRoom();
    join(room, 'host');
    join(room, 'a');
    room.setLocked(true);
    expect(join(room, 'late').error).toBe('ROOM_LOCKED');
    expect(join(room, 'a').reconnected).toBe(true);
    room.setLocked(false);
    expect(join(room, 'late').participant).toBeDefined();
  });
});

describe('hands, presenter slot and succession', () => {
  it('keeps the hand queue in the order hands were raised', () => {
    const room = makeRoom();
    join(room, 'host');
    ['a', 'b', 'c'].forEach((id) => join(room, id));
    vi.useFakeTimers();
    vi.setSystemTime(1000); room.setHand('c', true);
    vi.setSystemTime(2000); room.setHand('a', true);
    vi.setSystemTime(3000); room.setHand('b', true);
    vi.useRealTimers();
    const queue = room.getParticipantList().filter((p) => p.handRaised).sort((x, y) => x.handRaisedAt - y.handRaisedAt).map((p) => p.userId);
    expect(queue).toEqual(['c', 'a', 'b']);
    room.setHand('a', false);
    expect(room.getParticipant('a').handRaisedAt).toBeNull();
  });

  it('gives the presenter slot to exactly one person at a time', () => {
    const room = makeRoom();
    join(room, 'host'); join(room, 'a'); join(room, 'b');
    expect(room.requestShare('a')).toEqual({ ok: true });
    expect(room.requestShare('b')).toEqual({ error: 'SHARE_IN_USE' });
    expect(room.releasePresenter('b', 'x')).toBe(false); // not the presenter
    expect(room.releasePresenter('a', 'stopped')).toBe(true);
    expect(room.releasePresenter('a', 'stopped')).toBe(false); // idempotent
    expect(room.requestShare('b')).toEqual({ ok: true });
  });

  it('frees the presenter slot when the presenter leaves', () => {
    const room = makeRoom();
    join(room, 'host'); join(room, 'a');
    room.requestShare('a');
    room.removeParticipant('a', 'left');
    expect(room.presenterId).toBeNull();
  });

  it('promotes the longest-present Moderator, else Participant, when the Host leaves', () => {
    const room = makeRoom();
    join(room, 'host'); join(room, 'p1'); join(room, 'm1');
    room.assignRole('m1', ROLES.MODERATOR);
    room.removeParticipant('host', 'left');
    expect(room.hostId).toBe('m1');
    const room2 = makeRoom({ roomId: 'XYZ234' });
    join(room2, 'host'); join(room2, 'p1'); join(room2, 'p2');
    room2.removeParticipant('host', 'left');
    expect(room2.getParticipant('p1').role).toBe(ROLES.HOST);
  });

  it('does not start a grace timer for someone who was removed', () => {
    const room = makeRoom();
    join(room, 'host');
    const { participant } = join(room, 'a');
    room.kick('a');
    room.disconnect(participant, participant.ws); // their socket closing after the kick
    expect(participant.graceTimer).toBeNull();
  });

  it('transferHost keeps exactly one Host', () => {
    const room = makeRoom();
    join(room, 'host'); join(room, 'a');
    room.transferHost('a');
    expect([...room.participants.values()].filter((p) => p.role === ROLES.HOST)).toHaveLength(1);
    expect(room.getParticipant('host').role).toBe(ROLES.PARTICIPANT);
  });

  it('removes a disconnected participant after the grace period', async () => {
    const room = makeRoom();
    join(room, 'host');
    const { participant } = join(room, 'a');
    room.disconnect(participant, participant.ws);
    expect(room.count).toBe(2);
    await new Promise((r) => setTimeout(r, 80));
    expect(room.count).toBe(1);
  });
});

describe('SFU webhook reconciliation', () => {
  it('frees the presenter slot when the screen-share track disappears, idempotently', () => {
    const room = makeRoom();
    join(room, 'host'); join(room, 'a');
    room.requestShare('a');
    const roomManager = { getRoom: () => room };
    const event = { type: 'track_unpublished', room: 'ABC234', identity: 'a', trackSource: 'SCREEN_SHARE' };
    handleSfuEvent({ roomManager }, event);
    handleSfuEvent({ roomManager }, event); // delivered twice
    expect(room.presenterId).toBeNull();
  });
  it('ignores events for unknown rooms and for people who are not presenting', () => {
    const room = makeRoom();
    join(room, 'host'); join(room, 'a');
    room.requestShare('a');
    handleSfuEvent({ roomManager: { getRoom: () => null } }, { type: 'participant_left', room: 'NOPE22', identity: 'a' });
    handleSfuEvent({ roomManager: { getRoom: () => room } }, { type: 'participant_left', room: 'ABC234', identity: 'host' });
    handleSfuEvent({ roomManager: { getRoom: () => room } }, { type: 'track_unpublished', room: 'ABC234', identity: 'a', trackSource: 'MICROPHONE' });
    expect(room.presenterId).toBe('a');
  });
});
