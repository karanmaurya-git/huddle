import { randomUUID } from 'node:crypto';
import { ROLES, DEFAULT_OPTIONS, LIMITS, CLOSE, isPrivileged } from './constants.js';
import { Participant } from './Participant.js';
import { encode } from './protocol.js';

const ROLE_ORDER = { [ROLES.HOST]: 0, [ROLES.MODERATOR]: 1, [ROLES.PARTICIPANT]: 2 };

/**
 * One active meeting (in memory). It owns participants, roles, the hand queue, the screen-share
 * "presenter slot", chat history and every broadcast. Only broadcast / broadcastExcept /
 * broadcastToPrivileged / Participant.send call ws.send, so a Redis Pub/Sub layer for multiple
 * server instances would be added in one place.
 */
export class Room {
  constructor({ roomId, hostId, maxParticipants, locked = false, options = {}, hooks = {} }) {
    this.roomId = roomId;
    this.hostId = String(hostId);
    this.maxParticipants = maxParticipants;
    this.locked = locked;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.hooks = hooks;

    this.participants = new Map(); // userId -> Participant (includes users inside their grace period)
    this.kicked = new Set(); // userIds removed by the host
    this.chatHistory = [];
    this.presenterId = null; // the one user allowed to share their screen
    this.evictTimer = null;
    this.closed = false;
  }

  // ---------- broadcasting ----------

  broadcast(type, payload) {
    const data = encode(type, payload); // serialize once, send to everyone
    for (const p of this.participants.values()) p.sendRaw(data);
  }

  broadcastExcept(excludeUserId, type, payload) {
    const data = encode(type, payload);
    for (const p of this.participants.values()) {
      if (p.userId !== excludeUserId) p.sendRaw(data);
    }
  }

  broadcastToPrivileged(type, payload) {
    const data = encode(type, payload);
    for (const p of this.participants.values()) {
      if (isPrivileged(p.role)) p.sendRaw(data);
    }
  }

  // ---------- membership ----------

  getParticipant(userId) {
    return this.participants.get(userId);
  }

  isKicked(userId) {
    return this.kicked.has(userId);
  }

  hasHost() {
    return [...this.participants.values()].some((p) => p.role === ROLES.HOST);
  }

  get count() {
    return this.participants.size;
  }

  getParticipantList() {
    return [...this.participants.values()]
      .map((p) => p.toPublic())
      .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.joinedAt - b.joinedAt);
  }

  /**
   * Adds a user, or re-attaches a new socket if they already hold a seat (refresh/reconnect).
   * This method is synchronous on purpose: the capacity check and the insert cannot be
   * interleaved with another join, so two people can never take the last seat together.
   */
  join({ userId, username, ws }) {
    const existing = this.participants.get(userId);
    if (existing) {
      const oldSocket = existing.ws;
      existing.attach(ws); // clears the grace timer, keeps role and seat (no second slot used)
      if (oldSocket && oldSocket !== ws) oldSocket.close(CLOSE.REPLACED, 'Replaced by a new connection');
      return { participant: existing, reconnected: true };
    }
    // The Host can always enter their own meeting, even if it was locked before it was unloaded.
    if (this.locked && userId !== this.hostId) return { error: 'ROOM_LOCKED' };
    if (this.participants.size >= this.maxParticipants) return { error: 'ROOM_FULL' };

    const role = userId === this.hostId && !this.hasHost() ? ROLES.HOST : ROLES.PARTICIPANT;
    const participant = new Participant({ userId, username, role, ws });
    this.participants.set(userId, participant);
    this.broadcastExcept(userId, 'user_joined', {
      userId,
      username,
      role,
      participants: this.getParticipantList(),
      count: this.count,
    });
    return { participant, reconnected: false };
  }

  /** Socket dropped: keep the seat for a grace period so a refresh does not lose the role. */
  disconnect(participant, ws) {
    // Ignore sockets that were already replaced, and people who are no longer members (kicked).
    if (this.closed || participant.ws !== ws || this.participants.get(participant.userId) !== participant) return;
    participant.detach();
    this.releasePresenter(participant.userId, 'disconnected');
    clearTimeout(participant.graceTimer);
    participant.graceTimer = setTimeout(
      () => this.removeParticipant(participant.userId, 'timeout'),
      this.options.disconnectGraceMs
    );
    participant.graceTimer.unref?.();
  }

  /** reason: 'left' | 'timeout' | 'removed'. */
  removeParticipant(userId, reason = 'left') {
    const participant = this.participants.get(userId);
    if (!participant) return null;

    clearTimeout(participant.graceTimer);
    this.releasePresenter(userId, reason);
    this.participants.delete(userId);

    const payload = {
      userId,
      username: participant.username,
      participants: this.getParticipantList(),
      count: this.count,
    };
    if (reason === 'removed') this.broadcast('participant_removed', payload);
    else this.broadcast('user_left', { ...payload, reason });

    if (participant.role === ROLES.HOST) this.promoteSuccessor();
    if (this.participants.size === 0) this.hooks.onEmpty?.(this);
    return participant;
  }

  /** Host (or a Moderator, for Participants) removes someone: tell them, drop them, block them. */
  kick(userId) {
    const participant = this.participants.get(userId);
    if (!participant) return null;
    this.kicked.add(userId);
    participant.send('removed_from_room', {
      roomId: this.roomId,
      message: 'You were removed from the meeting',
    });
    this.removeParticipant(userId, 'removed');
    participant.close(CLOSE.REMOVED, 'Removed');
    return participant;
  }

  // ---------- roles ----------

  assignRole(userId, role) {
    const participant = this.participants.get(userId);
    if (!participant) return null;
    participant.role = role;
    this.broadcast('role_assigned', {
      userId,
      username: participant.username,
      role,
      participants: this.getParticipantList(),
    });
    return participant;
  }

  /** Atomic swap: nobody is ever Host twice, and the old Host becomes a Participant. */
  transferHost(newHostId, reason = 'transfer') {
    const target = this.participants.get(newHostId);
    if (!target) return null;
    const oldHostId = this.hostId;

    for (const p of this.participants.values()) {
      if (p.role === ROLES.HOST) p.role = ROLES.PARTICIPANT;
    }
    target.role = ROLES.HOST;
    this.hostId = newHostId;

    this.broadcast('host_transferred', {
      oldHostId,
      newHostId,
      newHostName: target.username,
      reason,
      participants: this.getParticipantList(),
    });
    this.hooks.onHostChange?.(this);
    return target;
  }

  /** Host left for good: longest-present Moderator, else Participant (connected users first). */
  promoteSuccessor() {
    const candidates = [...this.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const pick = (role) =>
      candidates.find((p) => p.role === role && p.connected) || candidates.find((p) => p.role === role);
    const successor = pick(ROLES.MODERATOR) || pick(ROLES.PARTICIPANT);
    if (successor) this.transferHost(successor.userId, 'succession');
  }

  setLocked(locked) {
    if (this.locked === locked) return false;
    this.locked = locked;
    this.broadcast('room_lock_changed', { locked });
    this.hooks.onLockChange?.(this);
    return true;
  }

  // ---------- hands ----------

  setHand(userId, raised) {
    const participant = this.participants.get(userId);
    if (!participant) return null;
    const isRaised = participant.handRaisedAt !== null;
    if (isRaised === raised) return participant; // nothing to change
    participant.handRaisedAt = raised ? Date.now() : null;
    this.broadcast('hand_changed', { userId, raised, at: participant.handRaisedAt });
    return participant;
  }

  // ---------- screen share presenter slot ----------

  /** Check-and-set in one synchronous step, so two requests can never both win the slot. */
  requestShare(userId) {
    if (this.presenterId && this.presenterId !== userId) return { error: 'SHARE_IN_USE' };
    this.presenterId = userId;
    return { ok: true };
  }

  /** Returns true if `userId` was the presenter. Safe to call repeatedly (idempotent). */
  releasePresenter(userId, reason, { silent = false } = {}) {
    if (this.presenterId !== userId) return false;
    this.presenterId = null;
    if (!silent) this.broadcast('screen_share_changed', { userId: null });
    this.hooks.onPresenterReleased?.(this, userId, reason);
    return true;
  }

  // ---------- chat ----------

  addChatMessage(participant, message) {
    const entry = {
      id: randomUUID(),
      userId: participant.userId,
      username: participant.username,
      message,
      timestamp: Date.now(),
    };
    this.chatHistory.push(entry);
    if (this.chatHistory.length > LIMITS.CHAT_HISTORY) this.chatHistory.shift();
    this.broadcast('chat_message', entry);
    return entry;
  }

  // ---------- lifecycle ----------

  /** The meeting ended or was deleted: tell everyone, disconnect them, stop all timers. */
  close(message) {
    this.closed = true;
    this.broadcast('meeting_ended', { roomId: this.roomId, message });
    for (const p of this.participants.values()) p.close(CLOSE.MEETING_ENDED, 'Meeting ended');
    this.destroy();
    this.participants.clear();
    this.presenterId = null;
  }

  destroy() {
    clearTimeout(this.evictTimer);
    for (const p of this.participants.values()) clearTimeout(p.graceTimer);
  }
}
