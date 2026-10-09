import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  startTestServer, registerUser, createMeeting, getTicket, joinAs, hostAndParticipant, TestClient, api, sleep,
} from './helpers/testServer.js';
import { getFakeMeeting, writes } from './helpers/fakeModels.js';

let srv;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(() => srv.close());
beforeEach(() => {
  srv.sfu.calls.length = 0;
  srv.sfu.failing.clear();
});

const del = (code, token) => api(srv.baseUrl, `/meetings/${code}`, { method: 'DELETE', token });
const idOf = (c) => c.joined.you.userId;

describe('connection and authentication', () => {
  it('rejects a WebSocket without a ticket, with a bad ticket, or with a bad Origin', async () => {
    await expect(new TestClient(srv.wsUrl, 'nope').opened).rejects.toThrow('HTTP 401');
    await expect(new TestClient(srv.wsUrl, '').opened).rejects.toThrow('HTTP 401');
    const user = await registerUser(srv.baseUrl, 'Origin');
    const code = await createMeeting(srv.baseUrl, user.token);
    const ticket = await getTicket(srv.baseUrl, user.token, code);
    await expect(new TestClient(srv.wsUrl, ticket, { Origin: 'https://evil.example' }).opened).rejects.toThrow('HTTP 403');
  });

  it('tickets are single use and expire', async () => {
    const user = await registerUser(srv.baseUrl, 'Once');
    const code = await createMeeting(srv.baseUrl, user.token);
    const ticket = await getTicket(srv.baseUrl, user.token, code);
    const first = new TestClient(srv.wsUrl, ticket);
    await first.opened;
    await expect(new TestClient(srv.wsUrl, ticket).opened).rejects.toThrow('HTTP 401');
    first.close();

    const expired = srv.ticketService.issue({ userId: user.user.id, username: 'Late', roomId: code });
    srv.ticketService.tickets.get(expired).expiresAt = Date.now() - 1;
    await expect(new TestClient(srv.wsUrl, expired).opened).rejects.toThrow('HTTP 401');
  });

  it('a ticket cannot be used to join a different meeting', async () => {
    const user = await registerUser(srv.baseUrl, 'Mixed');
    const a = await createMeeting(srv.baseUrl, user.token);
    const b = await createMeeting(srv.baseUrl, user.token);
    const client = new TestClient(srv.wsUrl, await getTicket(srv.baseUrl, user.token, a));
    await client.opened;
    client.send('join_room', { roomId: b });
    expect((await client.waitFor('error')).code).toBe('ROOM_MISMATCH');
    client.close();
  });

  it('answers malformed JSON, bad shapes, unknown events and pre-join messages with structured errors', async () => {
    const { host } = await hostAndParticipant(srv);
    host.client.sendRaw('{not json');
    expect((await host.client.waitFor('error')).code).toBe('INVALID_JSON');
    host.client.sendRaw(JSON.stringify([1]));
    expect((await host.client.waitFor('error')).code).toBe('INVALID_MESSAGE');
    host.client.sendRaw(JSON.stringify({ type: 'chat_message', payload: 'string' }));
    expect((await host.client.waitFor('error')).code).toBe('INVALID_MESSAGE');
    host.client.send('format_disk');
    expect((await host.client.waitFor('error')).code).toBe('UNKNOWN_EVENT');
    host.client.send('constructor'); // prototype keys must not be treated as handlers
    expect((await host.client.waitFor('error')).code).toBe('UNKNOWN_EVENT');

    const user = await registerUser(srv.baseUrl, 'Eager');
    const code = await createMeeting(srv.baseUrl, user.token);
    const early = new TestClient(srv.wsUrl, await getTicket(srv.baseUrl, user.token, code));
    await early.opened;
    early.send('chat_message', { message: 'hi' });
    expect((await early.waitFor('error')).code).toBe('NOT_IN_ROOM');
    early.close();
  });
});

describe('joining and the participant list', () => {
  it('the creator joins as Host, the next user as Participant, with the full list', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    expect(host.joined.you.role).toBe('host');
    expect(bob.joined.you.role).toBe('participant');
    expect(bob.joined).toMatchObject({ roomId, locked: false, capacity: 100, count: 2, presenterId: null, reconnected: false });
    expect(bob.joined.participants.map((p) => p.role)).toEqual(['host', 'participant']);
    const userJoined = await host.client.waitFor('user_joined');
    expect(userJoined).toMatchObject({ username: 'Bob', count: 2 });
  });

  it('a late joiner sees raised hands, the presenter, the lock state and chat history', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    bob.client.send('raise_hand', { raised: true });
    await host.client.waitFor('hand_changed');
    bob.client.send('screen_share_request');
    await bob.client.waitFor('screen_share_granted');
    host.client.send('chat_message', { message: 'welcome' });
    await host.client.waitFor('chat_message');
    host.client.send('lock_room'); // existing members only matter for a late joiner: unlock again
    await host.client.waitFor('room_lock_changed');
    host.client.send('unlock_room');
    await host.client.waitFor('room_lock_changed', (p) => p.locked === false);

    const late = await joinAs(srv, 'Late', roomId);
    expect(late.joined.presenterId).toBe(idOf(bob));
    expect(late.joined.participants.find((p) => p.userId === idOf(bob))).toMatchObject({ handRaised: true });
    expect(late.joined.chat.map((m) => m.message)).toContain('welcome');
  });

  it('records the meeting for "recent meetings" when someone joins', async () => {
    const { roomId, bob } = await hostAndParticipant(srv);
    const res = await api(srv.baseUrl, '/meetings', { token: bob.auth.token });
    expect(res.body.meetings.some((m) => m.code === roomId)).toBe(true);
  });

  it('returns ROOM_NOT_FOUND (close 4004) for a meeting that does not exist', async () => {
    const user = await registerUser(srv.baseUrl, 'Ghost');
    const ticket = srv.ticketService.issue({ userId: user.user.id, username: 'Ghost', roomId: 'ZZZZZ9' });
    const client = new TestClient(srv.wsUrl, ticket);
    await client.opened;
    client.send('join_room', { roomId: 'ZZZZZ9' });
    expect((await client.waitFor('error')).code).toBe('ROOM_NOT_FOUND');
    expect(await client.closed).toBe(4004);
  });
});

describe('capacity and lock', () => {
  it('rejects the third person when the meeting holds two, and reconnects do not use a seat', async () => {
    const host = await registerUser(srv.baseUrl, 'Cap');
    const code = await createMeeting(srv.baseUrl, host.token);
    srv.roomManager.getRoom(code).maxParticipants = 2;
    const a = await joinAs(srv, 'Cap', code, host.token);
    const b = await joinAs(srv, 'Bee', code);

    const user3 = await registerUser(srv.baseUrl, 'Cee');
    const c = new TestClient(srv.wsUrl, await getTicket(srv.baseUrl, user3.token, code));
    await c.opened;
    c.send('join_room', { roomId: code });
    expect((await c.waitFor('error')).code).toBe('ROOM_FULL');
    expect(await c.closed).toBe(1000);

    const again = await joinAs(srv, 'Bee', code, b.auth.token); // replaces B's connection, no extra seat
    expect(again.joined).toMatchObject({ reconnected: true, count: 2 });
    a.client.close();
  });

  it('admits exactly the capacity when many people join at the same instant', async () => {
    const host = await registerUser(srv.baseUrl, 'Race');
    const code = await createMeeting(srv.baseUrl, host.token);
    srv.roomManager.getRoom(code).maxParticipants = 3;
    const clients = [];
    for (let i = 0; i < 8; i += 1) {
      const u = await registerUser(srv.baseUrl, `R${i}`);
      const c = new TestClient(srv.wsUrl, await getTicket(srv.baseUrl, u.token, code));
      await c.opened;
      clients.push(c);
    }
    clients.forEach((c) => c.send('join_room', { roomId: code })); // all at once
    await sleep(500);
    const joined = clients.filter((c) => c.messages.some((m) => m.type === 'room_joined')).length;
    const full = clients.filter((c) => c.messages.some((m) => m.type === 'error' && m.payload.code === 'ROOM_FULL')).length;
    expect(joined).toBe(3);
    expect(full).toBe(5);
    expect(srv.roomManager.getRoom(code).count).toBe(3);
  });

  it('lock rejects newcomers but lets existing members reconnect; only the Host can lock; unlock reopens', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    bob.client.send('lock_room');
    expect((await bob.client.waitFor('error')).code).toBe('FORBIDDEN');

    host.client.send('lock_room');
    expect((await bob.client.waitFor('room_lock_changed')).locked).toBe(true);
    expect(getFakeMeeting(roomId).locked).toBe(true);

    const newcomer = await registerUser(srv.baseUrl, 'Newcomer');
    const c = new TestClient(srv.wsUrl, await getTicket(srv.baseUrl, newcomer.token, roomId));
    await c.opened;
    c.send('join_room', { roomId });
    expect((await c.waitFor('error')).code).toBe('ROOM_LOCKED');

    const back = await joinAs(srv, 'Bob', roomId, bob.auth.token); // existing member
    expect(back.joined.reconnected).toBe(true);

    host.client.send('unlock_room');
    await host.client.waitFor('room_lock_changed', (p) => p.locked === false);
    const ok = await joinAs(srv, 'Newcomer', roomId, newcomer.token);
    expect(ok.joined.locked).toBe(false);
  });
});

describe('chat', () => {
  it('delivers inside the meeting, validates, rate limits and never leaks to another meeting', async () => {
    const { host, bob } = await hostAndParticipant(srv);
    const other = await hostAndParticipant(srv);

    bob.client.send('chat_message', { message: '  Nice!  ' });
    const msg = await host.client.waitFor('chat_message');
    expect(msg).toMatchObject({ message: 'Nice!', username: 'Bob', userId: idOf(bob) });
    expect(msg.timestamp).toBeTypeOf('number');
    expect(await other.host.client.expectNone('chat_message')).toHaveLength(0);

    bob.client.send('chat_message', { message: '   ' });
    expect((await bob.client.waitFor('error')).code).toBe('INVALID_PAYLOAD');
    bob.client.send('chat_message', { message: 'x'.repeat(501) });
    expect((await bob.client.waitFor('error')).code).toBe('INVALID_PAYLOAD');
    for (let i = 0; i < 6; i += 1) bob.client.send('chat_message', { message: `m${i}` });
    expect((await bob.client.waitFor('error', (e) => e.code === 'RATE_LIMITED')).code).toBe('RATE_LIMITED');
  });
});

describe('raise hand', () => {
  it('lets anyone raise and lower their own hand and keeps the queue time', async () => {
    const { host, bob } = await hostAndParticipant(srv);
    bob.client.send('raise_hand', { raised: true });
    const raised = await host.client.waitFor('hand_changed');
    expect(raised).toMatchObject({ userId: idOf(bob), raised: true });
    expect(raised.at).toBeTypeOf('number');
    bob.client.send('raise_hand', { raised: false });
    expect((await host.client.waitFor('hand_changed', (p) => p.raised === false)).at).toBeNull();
    bob.client.send('raise_hand', { raised: 'yes' });
    expect((await bob.client.waitFor('error')).code).toBe('INVALID_PAYLOAD');
  });

  it('lets a Moderator lower a Participant\'s hand but not a Participant lower someone else\'s', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    const mod = await joinAs(srv, 'Mod', roomId);
    host.client.send('assign_role', { userId: idOf(mod), role: 'moderator' });
    await mod.client.waitFor('role_assigned');
    const carol = await joinAs(srv, 'Carol', roomId);

    carol.client.send('raise_hand', { raised: true });
    await mod.client.waitFor('hand_changed');
    bob.client.send('lower_hand', { userId: idOf(carol) });
    expect((await bob.client.waitFor('error')).code).toBe('FORBIDDEN');
    mod.client.send('lower_hand', { userId: idOf(carol) });
    expect((await carol.client.waitFor('hand_changed', (p) => p.raised === false)).userId).toBe(idOf(carol));
  });
});

describe('moderation', () => {
  it('Host mutes someone: the SFU is told, the target is notified; a Participant is forbidden', async () => {
    const { host, bob } = await hostAndParticipant(srv);
    host.client.send('mute_participant', { userId: idOf(bob) });
    expect(await bob.client.waitFor('force_muted')).toMatchObject({ by: idOf(host), byName: 'Host' });
    expect(srv.sfu.callsOf('muteMicrophone')).toHaveLength(1);
    expect(srv.sfu.callsOf('muteMicrophone')[0].args[1]).toBe(idOf(bob));

    bob.client.send('mute_participant', { userId: idOf(host) });
    expect((await bob.client.waitFor('error')).code).toBe('FORBIDDEN');
    expect(await host.client.expectNone('force_muted')).toHaveLength(0);
    expect(srv.sfu.callsOf('muteMicrophone')).toHaveLength(1);
  });

  it('still notifies the target but warns the actor when the media server cannot enforce a mute', async () => {
    const { host, bob } = await hostAndParticipant(srv);
    srv.sfu.failing.add('muteMicrophone');
    host.client.send('mute_participant', { userId: idOf(bob) });
    await bob.client.waitFor('force_muted');
    expect((await host.client.waitFor('error')).code).toBe('SFU_UNAVAILABLE');
  });

  it('a Moderator can act on Participants but not on the Host or another Moderator', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    const mod1 = await joinAs(srv, 'Mod1', roomId);
    const mod2 = await joinAs(srv, 'Mod2', roomId);
    for (const m of [mod1, mod2]) {
      host.client.send('assign_role', { userId: idOf(m), role: 'moderator' });
      await m.client.waitFor('role_assigned');
    }
    mod1.client.send('mute_participant', { userId: idOf(host) });
    expect((await mod1.client.waitFor('error')).code).toBe('FORBIDDEN');
    mod1.client.send('remove_participant', { userId: idOf(mod2) });
    expect((await mod1.client.waitFor('error', (e) => e.code === 'FORBIDDEN')).code).toBe('FORBIDDEN');
    mod1.client.send('mute_participant', { userId: idOf(bob) });
    await bob.client.waitFor('force_muted');
  });

  it('removes a participant: they are told, disconnected, removed from the SFU and cannot come back', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    host.client.send('remove_participant', { userId: idOf(bob) });
    expect((await bob.client.waitFor('removed_from_room')).roomId).toBe(roomId);
    const removed = await host.client.waitFor('participant_removed');
    expect(removed.participants).toHaveLength(1);
    expect(await bob.client.closed).toBe(4001);
    await sleep(50);
    expect(srv.sfu.callsOf('removeParticipant')[0].args).toEqual([roomId, idOf(bob)]);
    const res = await api(srv.baseUrl, '/auth/ws-ticket', { method: 'POST', token: bob.auth.token, body: { roomId } });
    expect(res.status).toBe(403);
    const sfuRes = await api(srv.baseUrl, `/meetings/${roomId}/sfu-token`, { method: 'POST', token: bob.auth.token });
    expect(sfuRes.status).toBe(403);
  });

  it('a Moderator can remove a Participant; the Host can remove a Moderator', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    const mod = await joinAs(srv, 'Mod', roomId);
    host.client.send('assign_role', { userId: idOf(mod), role: 'moderator' });
    await mod.client.waitFor('role_assigned');
    mod.client.send('remove_participant', { userId: idOf(bob) });
    expect(await bob.client.closed).toBe(4001);
    host.client.send('remove_participant', { userId: idOf(mod) });
    expect(await mod.client.closed).toBe(4001);
  });

  it('assigns and revokes Moderator, tells the SFU, and rejects Participants, bad roles and self-targets', async () => {
    const { host, bob } = await hostAndParticipant(srv);
    host.client.send('assign_role', { userId: idOf(bob), role: 'moderator' });
    const assigned = await bob.client.waitFor('role_assigned');
    expect(assigned).toMatchObject({ role: 'moderator', username: 'Bob' });
    expect(assigned.participants.map((p) => p.role)).toEqual(['host', 'moderator']);
    await sleep(30);
    expect(srv.sfu.callsOf('updateRole')[0].args).toEqual([host.joined.roomId, idOf(bob), 'moderator']);

    host.client.send('assign_role', { userId: idOf(bob), role: 'participant' });
    expect((await bob.client.waitFor('role_assigned', (p) => p.role === 'participant')).role).toBe('participant');

    bob.client.send('assign_role', { userId: idOf(host), role: 'participant' });
    expect((await bob.client.waitFor('error')).code).toBe('FORBIDDEN');
    host.client.send('assign_role', { userId: idOf(bob), role: 'host' });
    expect((await host.client.waitFor('error')).code).toBe('INVALID_PAYLOAD');
    host.client.send('assign_role', { userId: idOf(host), role: 'moderator' });
    expect((await host.client.waitFor('error')).code).toBe('INVALID_TARGET');
  });

  it('a Moderator cannot assign roles, transfer Host, lock or end the meeting', async () => {
    const { host, bob } = await hostAndParticipant(srv);
    host.client.send('assign_role', { userId: idOf(bob), role: 'moderator' });
    await bob.client.waitFor('role_assigned');
    for (const [type, payload] of [['assign_role', { userId: idOf(host), role: 'participant' }], ['transfer_host', { userId: idOf(bob) }], ['lock_room', {}], ['end_meeting', {}]]) {
      bob.client.send(type, payload);
      expect((await bob.client.waitFor('error')).code).toBe('FORBIDDEN');
    }
  });

  it('transfers Host (old Host becomes Participant) and succession picks a Moderator when the Host leaves', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    host.client.send('transfer_host', { userId: idOf(bob) });
    const event = await bob.client.waitFor('host_transferred');
    expect(event).toMatchObject({ oldHostId: idOf(host), newHostId: idOf(bob), reason: 'transfer' });
    expect(Object.fromEntries(event.participants.map((p) => [p.username, p.role]))).toEqual({ Bob: 'host', Host: 'participant' });
    expect(getFakeMeeting(roomId).hostId).toBe(idOf(bob)); // persisted

    const carol = await joinAs(srv, 'Carol', roomId);
    bob.client.send('assign_role', { userId: idOf(carol), role: 'moderator' });
    await carol.client.waitFor('role_assigned');
    bob.client.send('leave_room');
    const succession = await host.client.waitFor('host_transferred', (p) => p.reason === 'succession');
    expect(succession.newHostId).toBe(idOf(carol));
  });
});

describe('screen share presenter slot', () => {
  it('grants the slot to one person, tells the SFU, rejects a second, and frees it on stop', async () => {
    const { host, bob } = await hostAndParticipant(srv);
    bob.client.send('screen_share_request');
    await bob.client.waitFor('screen_share_granted');
    expect((await host.client.waitFor('screen_share_changed')).userId).toBe(idOf(bob));
    expect(srv.sfu.callsOf('setScreenSharePermission')[0].args).toEqual([host.joined.roomId, idOf(bob), true]);

    host.client.send('screen_share_request');
    expect((await host.client.waitFor('error')).code).toBe('SHARE_IN_USE');

    bob.client.send('screen_share_stop');
    expect((await host.client.waitFor('screen_share_changed', (p) => p.userId === null)).userId).toBeNull();
    await sleep(30);
    expect(srv.sfu.callsOf('stopScreenShare')).toHaveLength(1); // permission taken away on the SFU

    host.client.send('screen_share_request'); // the slot is free again
    await host.client.waitFor('screen_share_granted');
  });

  it('frees the slot if the SFU refuses, and when the presenter leaves', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    srv.sfu.failing.add('setScreenSharePermission');
    bob.client.send('screen_share_request');
    expect((await bob.client.waitFor('error')).code).toBe('SFU_UNAVAILABLE');
    expect(srv.roomManager.getRoom(roomId).presenterId).toBeNull();
    srv.sfu.failing.clear();

    bob.client.send('screen_share_request');
    await bob.client.waitFor('screen_share_granted');
    bob.client.send('leave_room');
    expect((await host.client.waitFor('screen_share_changed', (p) => p.userId === null)).userId).toBeNull();
  });

  it('lets a Moderator stop a Participant\'s share; a Participant cannot', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    const carol = await joinAs(srv, 'Carol', roomId);
    bob.client.send('screen_share_request');
    await bob.client.waitFor('screen_share_granted');

    carol.client.send('stop_screen_share_for', { userId: idOf(bob) });
    expect((await carol.client.waitFor('error')).code).toBe('FORBIDDEN');
    host.client.send('stop_screen_share_for', { userId: idOf(carol) });
    expect((await host.client.waitFor('error')).code).toBe('INVALID_TARGET'); // Carol is not sharing
    host.client.send('stop_screen_share_for', { userId: idOf(bob) });
    expect((await bob.client.waitFor('screen_share_stopped')).by).toBe(idOf(host));
    expect((await carol.client.waitFor('screen_share_changed', (p) => p.userId === null)).userId).toBeNull();
  });
});

describe('ending a meeting', () => {
  it('Host ends it: everyone is told and disconnected, the SFU room is deleted, joining again is refused', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    host.client.send('end_meeting');
    expect((await bob.client.waitFor('meeting_ended')).roomId).toBe(roomId);
    expect(await bob.client.closed).toBe(4005);
    expect(await host.client.closed).toBe(4005);
    await sleep(30);
    expect(srv.sfu.callsOf('deleteRoom')[0].args[0]).toBe(roomId);
    expect(getFakeMeeting(roomId).status).toBe('ended');
    expect(srv.roomManager.getRoom(roomId)).toBeUndefined();
    const res = await api(srv.baseUrl, '/auth/ws-ticket', { method: 'POST', token: bob.auth.token, body: { roomId } });
    expect(res.status).toBe(410);

    await sleep(800); // timers of the closed room must not bring it back
    expect(srv.roomManager.getRoom(roomId)).toBeUndefined();
  });

  it('a Participant cannot end the meeting; deleting via REST closes a live meeting and removes the record', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    bob.client.send('end_meeting');
    expect((await bob.client.waitFor('error')).code).toBe('FORBIDDEN');
    expect((await del(roomId, bob.auth.token)).status).toBe(403);

    expect((await del(roomId, host.auth.token)).status).toBe(200);
    expect((await bob.client.waitFor('meeting_ended')).message).toMatch(/deleted/);
    expect(await bob.client.closed).toBe(4005);
    expect(getFakeMeeting(roomId)).toBeUndefined();
  });

  it('after a Host transfer only the new Host can delete', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    host.client.send('transfer_host', { userId: idOf(bob) });
    await bob.client.waitFor('host_transferred');
    expect((await del(roomId, host.auth.token)).status).toBe(403);
    expect((await del(roomId, bob.auth.token)).status).toBe(200);
  });
});

describe('disconnect grace period and reconnection', () => {
  it('a reconnect within the grace period restores the role without a user_left', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    host.client.send('assign_role', { userId: idOf(bob), role: 'moderator' });
    await bob.client.waitFor('role_assigned');
    bob.client.close();
    await bob.client.closed;
    expect(await host.client.expectNone('user_left', 100)).toHaveLength(0);

    const again = await joinAs(srv, 'Bob', roomId, bob.auth.token); // fresh ticket, same user
    expect(again.joined).toMatchObject({ reconnected: true });
    expect(again.joined.you.role).toBe('moderator');
    expect(await host.client.expectNone('user_left', 500)).toHaveLength(0);
  });

  it('removes the participant when the grace period expires and the second connection replaces the first', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    bob.client.close();
    const left = await host.client.waitFor('user_left', () => true, 1500);
    expect(left).toMatchObject({ username: 'Bob', reason: 'timeout', count: 1 });

    const carol = await joinAs(srv, 'Carol', roomId);
    const second = await joinAs(srv, 'Carol', roomId, carol.auth.token);
    expect(await carol.client.closed).toBe(4002);
    expect(second.joined.reconnected).toBe(true);
  });

  it('frees a presenting user\'s slot as soon as their connection drops', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    bob.client.send('screen_share_request');
    await bob.client.waitFor('screen_share_granted');
    bob.client.close();
    expect((await host.client.waitFor('screen_share_changed', (p) => p.userId === null)).userId).toBeNull();
    expect(srv.roomManager.getRoom(roomId).presenterId).toBeNull();
  });
});

describe('persistence', () => {
  it('writes to the database only on the allowed events, never on chat, hands, mute or sharing', async () => {
    const { host, bob } = await hostAndParticipant(srv);
    const before = { ...writes };
    bob.client.send('chat_message', { message: 'hello' });
    await host.client.waitFor('chat_message');
    bob.client.send('raise_hand', { raised: true });
    await host.client.waitFor('hand_changed');
    host.client.send('mute_participant', { userId: idOf(bob) });
    await bob.client.waitFor('force_muted');
    bob.client.send('screen_share_request');
    await bob.client.waitFor('screen_share_granted');
    bob.client.send('screen_share_stop');
    await host.client.waitFor('screen_share_changed', (p) => p.userId === null);
    expect(writes).toEqual(before);
  });

  it('unloads an empty meeting from memory but keeps it; joining again reloads it and the creator is Host', async () => {
    const { roomId, host, bob } = await hostAndParticipant(srv);
    host.client.send('lock_room');
    await host.client.waitFor('room_lock_changed');
    host.client.close();
    bob.client.close();
    for (let i = 0; i < 100 && srv.roomManager.getRoom(roomId); i += 1) await sleep(30);
    expect(srv.roomManager.getRoom(roomId)).toBeUndefined();
    expect(getFakeMeeting(roomId)).toMatchObject({ status: 'active', locked: true });

    const back = await joinAs(srv, 'Host', roomId, host.auth.token);
    expect(back.joined.you.role).toBe('host');
    expect(back.joined.locked).toBe(true); // lock state survived the reload
  });
});
