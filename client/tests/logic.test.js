import { describe, it, expect } from 'vitest';
import { planSubscriptions, paginate, plansEqual, shouldApplyPlan, applyDelay, DEFAULT_PLAN_CONFIG } from '../src/meeting/subscriptionPlanner.js';
import { computeWindow } from '../src/meeting/windowList.js';
import { canActOn, personActions, meetingCapabilities, isPrivileged } from '../src/meeting/capabilities.js';
import { backoffDelay, shouldReconnect } from '../src/meeting/backoff.js';
import { decideRecovery } from '../src/meeting/recovery.js';
import { reducer, initialState, applyServerMessage } from '../src/meeting/meetingReducer.js';

const people = (n, withVideo = () => true) =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i}`, hasVideo: withVideo(i) }));

describe('subscription planner: speaker view', () => {
  it('puts the active speaker on the stage and subscribes to their video', () => {
    const plan = planSubscriptions({ participants: people(5), selfId: 'u0', activeSpeakers: ['u3'] });
    expect(plan.effectiveLayout).toBe('speaker');
    expect(plan.stageId).toBe('u3');
    expect(plan.video.has('u3')).toBe(true);
    expect(plan.video.has('u0')).toBe(false); // never subscribe to yourself
  });

  it('stage priority is screen share, then pinned, then speaker, then recent speaker, then a camera', () => {
    const base = { participants: people(6), selfId: 'u0', activeSpeakers: ['u2'], recentSpeakers: ['u4'] };
    expect(planSubscriptions({ ...base, screenSharerId: 'u5', pinnedId: 'u1' }).stageId).toBe('u5');
    expect(planSubscriptions({ ...base, pinnedId: 'u1' }).stageId).toBe('u1');
    expect(planSubscriptions(base).stageId).toBe('u2');
    expect(planSubscriptions({ ...base, activeSpeakers: [] }).stageId).toBe('u4');
    expect(planSubscriptions({ participants: people(4, (i) => i === 3), selfId: 'u0' }).stageId).toBe('u3');
    expect(planSubscriptions({ participants: people(1), selfId: 'u0' }).stageId).toBeNull(); // alone
  });

  it('caps the strip, orders it by recent speakers, and skips cameras that are off', () => {
    const participants = people(30, (i) => i % 2 === 0);
    const plan = planSubscriptions({ participants, selfId: 'u0', activeSpeakers: ['u9'], recentSpeakers: ['u7', 'u8'] });
    expect(plan.stripIds.length).toBe(DEFAULT_PLAN_CONFIG.stripSize);
    expect(plan.stripIds.slice(0, 2)).toEqual(['u7', 'u8']); // recent speakers first (u9 is on stage)
    for (const id of plan.video) expect(participants.find((p) => p.id === id).hasVideo).toBe(true);
  });

  it('screen share takes the stage, subscribes to the sharer, and forces speaker layout', () => {
    const plan = planSubscriptions({ participants: people(5), selfId: 'u0', layout: 'gallery', screenSharerId: 'u2' });
    expect(plan.effectiveLayout).toBe('speaker');
    expect(plan.stageKind).toBe('screen');
    expect(plan.screen).toBe('u2');
    expect(plan.stripIds).toContain('u2'); // the sharer's camera still appears in the strip
  });

  it('does not subscribe to your own screen share; a pinned person also forces speaker layout', () => {
    expect(planSubscriptions({ participants: people(3), selfId: 'u0', screenSharerId: 'u0' }).screen).toBeNull();
    expect(planSubscriptions({ participants: people(4), selfId: 'u0', layout: 'gallery', pinnedId: 'u2' }).effectiveLayout).toBe('speaker');
  });
});

describe('subscription planner: gallery view', () => {
  it('only subscribes to cameras on the current page', () => {
    const participants = people(40);
    const p0 = planSubscriptions({ participants, selfId: 'u0', layout: 'gallery', page: 0 });
    const p2 = planSubscriptions({ participants, selfId: 'u0', layout: 'gallery', page: 2 });
    expect(p0.pageCount).toBe(4); // 40 people / 12 per page
    expect(p0.pageIds).toHaveLength(12);
    expect(p0.video.has('u5')).toBe(true);
    expect(p0.video.has('u20')).toBe(false); // off-screen
    expect(p2.pageIds[0]).toBe('u24'); // page 2 holds people 24 to 35
    expect(p2.video.has('u30')).toBe(true);
    expect(p2.video.has('u5')).toBe(false);
  });

  it('clamps the page and keeps the order stable', () => {
    expect(paginate(['a', 'b', 'c'], 99, 2)).toEqual({ pageIds: ['c'], page: 1, pageCount: 2 });
    expect(paginate(['a'], -3, 2)).toEqual({ pageIds: ['a'], page: 0, pageCount: 1 });
    expect(paginate([], 0, 12).pageCount).toBe(1);
  });
});

describe('subscription planner: scale and audio', () => {
  it('with 100 people it still subscribes to at most a handful of videos and 10 audio tracks', () => {
    const participants = people(100);
    const speaker = planSubscriptions({ participants, selfId: 'u0', activeSpeakers: ['u40'], recentSpeakers: Array.from({ length: 20 }, (_, i) => `u${50 + i}`) });
    expect(speaker.video.size).toBeLessThanOrEqual(DEFAULT_PLAN_CONFIG.stripSize + 1);
    expect(speaker.audio.size).toBe(DEFAULT_PLAN_CONFIG.audioTopN);
    expect(speaker.audio.has('u40')).toBe(true);
    const gallery = planSubscriptions({ participants, selfId: 'u0', layout: 'gallery' });
    expect(gallery.video.size).toBeLessThanOrEqual(DEFAULT_PLAN_CONFIG.pageSize);
  });

  it('listens to everyone in a small meeting and always includes the sharer in a big one', () => {
    const small = planSubscriptions({ participants: people(20), selfId: 'u0' });
    expect(small.audio.size).toBe(19);
    const big = planSubscriptions({ participants: people(80), selfId: 'u0', screenSharerId: 'u70', recentSpeakers: Array.from({ length: 30 }, (_, i) => `u${i + 1}`) });
    expect(big.audio.has('u70')).toBe(true);
    expect(big.audio.size).toBe(DEFAULT_PLAN_CONFIG.audioTopN);
  });

  it('respects a custom config', () => {
    const plan = planSubscriptions({ participants: people(10), selfId: 'u0', layout: 'gallery', config: { pageSize: 4 } });
    expect(plan.pageIds).toHaveLength(4);
    expect(plan.pageCount).toBe(3);
  });
});

describe('throttling subscription changes', () => {
  const plan = (video, screen = null) => ({ video: new Set(video), audio: new Set(), screen });
  it('applies the first plan, ignores identical plans, and throttles quick changes', () => {
    expect(shouldApplyPlan(null, plan(['a']), 1000, 0)).toBe(true);
    expect(shouldApplyPlan(plan(['a']), plan(['a']), 5000, 0)).toBe(false);
    expect(plansEqual(plan(['a', 'b']), plan(['b', 'a']))).toBe(true);
    expect(shouldApplyPlan(plan(['a']), plan(['b']), 1100, 1000)).toBe(false); // too soon
    expect(shouldApplyPlan(plan(['a']), plan(['b']), 1500, 1000)).toBe(true);
    expect(applyDelay(1100, 1000)).toBe(300);
    expect(applyDelay(2000, 1000)).toBe(0);
  });
  it('applies a screen-share change immediately', () => {
    expect(shouldApplyPlan(plan(['a']), plan(['a'], 'u2'), 1001, 1000)).toBe(true);
  });
});

describe('windowed list', () => {
  it('renders only the visible rows plus overscan', () => {
    expect(computeWindow({ scrollTop: 0, viewportHeight: 300, rowHeight: 50, total: 100, overscan: 2 })).toEqual({ start: 0, end: 8, offsetTop: 0, totalHeight: 5000 });
    expect(computeWindow({ scrollTop: 1000, viewportHeight: 300, rowHeight: 50, total: 100, overscan: 2 })).toEqual({ start: 18, end: 28, offsetTop: 900, totalHeight: 5000 });
    expect(computeWindow({ scrollTop: 9999, viewportHeight: 300, rowHeight: 50, total: 100 }).end).toBe(100);
    expect(computeWindow({ scrollTop: 0, viewportHeight: 300, rowHeight: 50, total: 3 }).end).toBe(3);
  });
});

describe('role capabilities (UI mirror of the server rules)', () => {
  const host = { userId: 'h', role: 'host' };
  const mod = { userId: 'm', role: 'moderator' };
  const p = { userId: 'p', role: 'participant', handRaised: true };
  it('matches the server: Host acts on anyone but self; Moderator only on Participants', () => {
    expect(canActOn(host, mod)).toBe(true);
    expect(canActOn(host, host)).toBe(false);
    expect(canActOn(mod, p)).toBe(true);
    expect(canActOn(mod, host)).toBe(false);
    expect(canActOn(p, host)).toBe(false);
    expect(canActOn(null, p)).toBe(false);
  });
  it('offers the right buttons per role', () => {
    expect(personActions(host, p)).toMatchObject({ mute: true, remove: true, lowerHand: true, makeModerator: true, makeParticipant: false, makeHost: true, stopShare: false });
    expect(personActions(host, mod)).toMatchObject({ makeModerator: false, makeParticipant: true });
    expect(personActions(mod, p)).toMatchObject({ mute: true, remove: true, makeModerator: false, makeHost: false });
    expect(personActions(mod, host)).toMatchObject({ mute: false, remove: false });
    expect(personActions(p, mod)).toMatchObject({ mute: false, remove: false, lowerHand: false });
    expect(personActions(host, p, { isSharing: true }).stopShare).toBe(true);
  });
  it('only the Host gets lock, end, roles and transfer', () => {
    expect(meetingCapabilities('host')).toEqual({ canLock: true, canEnd: true, canAssignRoles: true, canTransferHost: true });
    expect(Object.values(meetingCapabilities('moderator')).some(Boolean)).toBe(false);
    expect(isPrivileged('moderator')).toBe(true);
    expect(isPrivileged('participant')).toBe(false);
  });
});

describe('reconnect and recovery decisions', () => {
  it('backs off 1s, 2s, 4s... up to 10s and never reconnects on terminal close codes', () => {
    expect([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a))).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
    for (const code of [1000, 4001, 4002, 4004, 4005]) expect(shouldReconnect(code)).toBe(false);
    for (const code of [1006, 1001, 4008]) expect(shouldReconnect(code)).toBe(true);
  });
  it('stops when terminal, waits for the app connection, retries with a fresh token, then gives up', () => {
    expect(decideRecovery({ terminal: true, attempt: 1, appConnected: true })).toEqual({ action: 'stop' });
    expect(decideRecovery({ terminal: false, attempt: 1, appConnected: false })).toEqual({ action: 'wait-for-app' });
    expect(decideRecovery({ terminal: false, attempt: 2, appConnected: true })).toEqual({ action: 'retry-with-fresh-token', delayMs: 2000 });
    expect(decideRecovery({ terminal: false, attempt: 6, appConnected: true })).toEqual({ action: 'give-up' });
  });
});

describe('meeting reducer', () => {
  const joined = (extra = {}) => ({
    type: 'server',
    message: {
      type: 'room_joined',
      payload: {
        you: { userId: 'me', username: 'Me', role: 'participant' },
        participants: [
          { userId: 'h', username: 'H', role: 'host', handRaised: false, handRaisedAt: null },
          { userId: 'me', username: 'Me', role: 'participant', handRaised: false, handRaisedAt: null },
        ],
        chat: [], locked: false, capacity: 100, count: 2, presenterId: null, ...extra,
      },
    },
  });
  const msg = (type, payload) => ({ type: 'server', message: { type, payload } });

  it('joins, and keeps my role in sync with the server list', () => {
    let s = reducer(initialState, joined());
    expect(s).toMatchObject({ status: 'connected', capacity: 100, count: 2 });
    s = reducer(s, msg('role_assigned', { participants: [{ userId: 'h', role: 'host' }, { userId: 'me', role: 'moderator' }] }));
    expect(s.me.role).toBe('moderator');
    s = reducer(s, msg('host_transferred', { participants: [{ userId: 'h', role: 'participant' }, { userId: 'me', role: 'host' }] }));
    expect(s.me.role).toBe('host');
  });

  it('tracks hands, presenter, lock, chat and counts', () => {
    let s = reducer(initialState, joined());
    s = reducer(s, msg('hand_changed', { userId: 'h', raised: true, at: 123 }));
    expect(s.participants.find((p) => p.userId === 'h')).toMatchObject({ handRaised: true, handRaisedAt: 123 });
    s = reducer(s, msg('screen_share_changed', { userId: 'h' }));
    expect(s.presenterId).toBe('h');
    s = reducer(s, msg('screen_share_changed', { userId: null }));
    expect(s.presenterId).toBeNull();
    s = reducer(s, msg('room_lock_changed', { locked: true }));
    expect(s.locked).toBe(true);
    s = reducer(s, msg('chat_message', { id: '1', message: 'hi' }));
    expect(s.chat).toHaveLength(1);
    s = reducer(s, msg('user_joined', { participants: [...s.participants, { userId: 'x', role: 'participant' }], count: 3 }));
    expect(s.count).toBe(3);
    expect(s.participants).toHaveLength(3);
  });

  it('maps fatal events and join errors to screens, and ignores ordinary errors', () => {
    const base = reducer(initialState, joined());
    expect(reducer(base, msg('removed_from_room', { message: 'gone' }))).toMatchObject({ status: 'removed', notice: 'gone' });
    expect(reducer(base, msg('meeting_ended', { message: 'bye' }))).toMatchObject({ status: 'ended', notice: 'bye' });
    expect(reducer(initialState, msg('error', { code: 'ROOM_FULL', message: 'full' })).status).toBe('full');
    expect(reducer(initialState, msg('error', { code: 'ROOM_LOCKED', message: 'locked' })).status).toBe('locked');
    expect(reducer(initialState, msg('error', { code: 'ROOM_NOT_FOUND', message: 'x' })).status).toBe('notfound');
    expect(reducer(base, msg('error', { code: 'FORBIDDEN', message: 'no' }))).toBe(base);
    expect(applyServerMessage(base, { type: 'unknown', payload: {} })).toBe(base);
  });

  it('keeps the first notice text when a close code repeats the same fatal status', () => {
    let s = reducer(initialState, msg('meeting_ended', { message: 'The host ended the meeting.' }));
    s = reducer(s, { type: 'fatal', status: 'ended', notice: 'generic' });
    expect(s.notice).toBe('The host ended the meeting.');
  });
});
