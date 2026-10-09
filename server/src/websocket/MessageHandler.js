import { ACTIONS, CLOSE, LIMITS, ROLES, can, canModerate } from './constants.js';
import { sendError } from './protocol.js';
import { RateLimiter } from '../utils/rateLimiter.js';
import { normalizeRoomCode } from '../utils/roomCode.js';

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const JOIN_ERRORS = {
  ROOM_FULL: 'This meeting is full',
  ROOM_LOCKED: 'The host locked this meeting',
};

/**
 * Parses, validates and authorizes every incoming WebSocket message, then delegates to Room.
 * Every protected event is checked in this order:
 *   authenticated (ticket) -> in the room -> role allowed -> target valid -> act -> broadcast
 * Media state (mic, camera) is NOT sent here: it lives on the SFU. This socket only carries
 * app events: presence, chat, hands, moderation and the screen-share slot.
 */
export class MessageHandler {
  constructor({ roomManager, sfu, lifecycle, persistence }) {
    this.roomManager = roomManager;
    this.sfu = sfu;
    this.lifecycle = lifecycle;
    this.persistence = persistence;
    this.handlers = {
      join_room: this.joinRoom,
      leave_room: this.leaveRoom,
      chat_message: this.chatMessage,
      raise_hand: this.raiseHand,
      lower_hand: this.lowerHand,
      screen_share_request: this.screenShareRequest,
      screen_share_stop: this.screenShareStop,
      stop_screen_share_for: this.stopScreenShareFor,
      mute_participant: this.muteParticipant,
      remove_participant: this.removeParticipant,
      assign_role: this.assignRole,
      transfer_host: this.transferHost,
      lock_room: (ctx) => this.setLocked(ctx, true),
      unlock_room: (ctx) => this.setLocked(ctx, false),
      end_meeting: this.endMeeting,
    };
  }

  /** `session` comes from the validated ticket: userId/username/roomId are server-decided. */
  handleConnection(ws, session) {
    const ctx = {
      ws,
      session,
      room: null,
      participant: null,
      limiter: new RateLimiter(LIMITS.MESSAGES_PER_SECOND, 1000),
      queue: Promise.resolve(), // messages from one socket are processed strictly in order
    };

    const joinTimer = setTimeout(() => {
      if (!ctx.participant) ws.close(CLOSE.JOIN_TIMEOUT, 'join_room required');
    }, LIMITS.JOIN_TIMEOUT_MS);
    joinTimer.unref?.();

    ws.on('message', (data) => {
      if (!ctx.limiter.allow()) return sendError(ws, 'RATE_LIMITED', 'Too many messages, slow down');
      ctx.queue = ctx.queue.then(() => this.process(ctx, data));
      return undefined;
    });
    ws.on('close', () => {
      clearTimeout(joinTimer);
      if (ctx.room && ctx.participant) ctx.room.disconnect(ctx.participant, ws);
    });
    ws.on('error', (err) => console.error('WebSocket error', err.message));
  }

  async process(ctx, data) {
    const { ws } = ctx;
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return sendError(ws, 'INVALID_JSON', 'Message must be valid JSON');
    }
    if (!isPlainObject(message) || typeof message.type !== 'string') {
      return sendError(ws, 'INVALID_MESSAGE', 'Message must look like { "type": string, "payload": object }');
    }
    if (message.payload !== undefined && !isPlainObject(message.payload)) {
      return sendError(ws, 'INVALID_MESSAGE', 'payload must be an object');
    }
    const handler = Object.hasOwn(this.handlers, message.type) ? this.handlers[message.type] : null;
    if (!handler) return sendError(ws, 'UNKNOWN_EVENT', `Unknown event type: ${message.type}`);

    try {
      return await handler.call(this, ctx, message.payload ?? {});
    } catch (err) {
      console.error(`Error handling "${message.type}"`, err);
      return sendError(ws, 'INTERNAL_ERROR', 'Something went wrong');
    }
  }

  // ---------- helpers ----------

  /** Returns { room, participant } only if the socket's user is still a member of its room. */
  member(ctx) {
    const { room, participant } = ctx;
    if (!room || !participant || room.closed || room.getParticipant(participant.userId) !== participant) {
      sendError(ctx.ws, 'NOT_IN_ROOM', 'Join a meeting first');
      return null;
    }
    return { room, participant };
  }

  /** member() + role check. Returns null (after replying with an error) if either fails. */
  authorize(ctx, action, message) {
    const found = this.member(ctx);
    if (!found) return null;
    if (!can(found.participant.role, action)) {
      sendError(ctx.ws, 'FORBIDDEN', message);
      return null;
    }
    return found;
  }

  /** Rate limit for hand/moderation style actions. */
  allowAction(ctx, participant) {
    if (participant.limits.action.allow()) return true;
    sendError(ctx.ws, 'RATE_LIMITED', 'Slow down a little');
    return false;
  }

  /** The user named in `payload.userId` must be a member of this room. */
  targetOf(ctx, payload, room) {
    if (typeof payload.userId !== 'string') {
      sendError(ctx.ws, 'INVALID_PAYLOAD', 'userId is required');
      return null;
    }
    const target = room.getParticipant(payload.userId);
    if (!target) {
      sendError(ctx.ws, 'TARGET_NOT_FOUND', 'That person is not in the meeting');
      return null;
    }
    return target;
  }

  /** Target for Host-only actions (assign role, transfer host): any member except yourself. */
  hostTarget(ctx, payload, found) {
    const target = this.targetOf(ctx, payload, found.room);
    if (!target) return null;
    if (target.userId === found.participant.userId) {
      sendError(ctx.ws, 'INVALID_TARGET', 'You cannot do that to yourself');
      return null;
    }
    return target;
  }

  /** Target for moderation (mute, remove...): enforces the Host / Moderator rules. */
  moderationTarget(ctx, payload, found) {
    const target = this.hostTarget(ctx, payload, found);
    if (!target) return null;
    if (!canModerate(found.participant, target)) {
      sendError(ctx.ws, 'FORBIDDEN', 'You cannot moderate this person');
      return null;
    }
    return target;
  }

  /** Media-server calls are best effort: the app keeps working if the SFU is unreachable. */
  async trySfu(label, fn) {
    try {
      await fn();
      return true;
    } catch (err) {
      console.error(`SFU ${label} failed:`, err.message);
      return false;
    }
  }

  // ---------- membership ----------

  async joinRoom(ctx, payload) {
    if (ctx.participant) return sendError(ctx.ws, 'ALREADY_JOINED', 'Already in a meeting');

    const roomId = normalizeRoomCode(payload.roomId);
    // The ticket was issued for one specific meeting; it cannot be used to enter another.
    if (!roomId || roomId !== ctx.session.roomId) {
      return sendError(ctx.ws, 'ROOM_MISMATCH', 'This ticket was issued for a different meeting');
    }

    const loaded = await this.roomManager.getOrLoadRoom(roomId);
    if (loaded.error === 'ROOM_NOT_FOUND') {
      sendError(ctx.ws, 'ROOM_NOT_FOUND', 'Meeting not found');
      return ctx.ws.close(CLOSE.NOT_FOUND, 'Meeting not found');
    }
    if (loaded.error === 'MEETING_ENDED' || loaded.room?.closed) {
      sendError(ctx.ws, 'MEETING_ENDED', 'This meeting has ended');
      return ctx.ws.close(CLOSE.MEETING_ENDED, 'Meeting ended');
    }

    const { room } = loaded;
    const { userId, username } = ctx.session;
    if (room.isKicked(userId)) {
      sendError(ctx.ws, 'REMOVED', 'You were removed from this meeting');
      return ctx.ws.close(CLOSE.REMOVED, 'Removed');
    }

    this.roomManager.cancelEviction(room);
    const result = room.join({ userId, username, ws: ctx.ws });
    if (result.error) {
      sendError(ctx.ws, result.error, JOIN_ERRORS[result.error]);
      if (room.count === 0) this.roomManager.scheduleEviction(room);
      return ctx.ws.close(CLOSE.NORMAL, result.error);
    }

    const { participant, reconnected } = result;
    ctx.room = room;
    ctx.participant = participant;
    if (!reconnected) {
      this.persistence.recordMembership(userId, roomId).catch((err) => console.error('recordMembership', err.message));
    }

    participant.send('room_joined', {
      roomId,
      you: participant.toPublic(),
      participants: room.getParticipantList(),
      chat: room.chatHistory,
      locked: room.locked,
      capacity: room.maxParticipants,
      count: room.count,
      presenterId: room.presenterId,
      reconnected,
    });
    return undefined;
  }

  leaveRoom(ctx) {
    const found = this.member(ctx);
    if (!found) return;
    found.room.removeParticipant(found.participant.userId, 'left');
    ctx.room = null;
    ctx.participant = null;
    ctx.ws.close(CLOSE.NORMAL, 'Left meeting');
  }

  // ---------- chat and hands ----------

  chatMessage(ctx, payload) {
    const found = this.authorize(ctx, ACTIONS.CHAT, 'You cannot chat in this meeting');
    if (!found) return;
    const text = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!text || text.length > LIMITS.MAX_CHAT_LENGTH) {
      return sendError(ctx.ws, 'INVALID_PAYLOAD', `Message must be 1-${LIMITS.MAX_CHAT_LENGTH} characters`);
    }
    if (!found.participant.limits.chat.allow()) {
      return sendError(ctx.ws, 'RATE_LIMITED', 'You are sending messages too quickly');
    }
    found.room.addChatMessage(found.participant, text);
    return undefined;
  }

  raiseHand(ctx, payload) {
    const found = this.authorize(ctx, ACTIONS.RAISE_HAND, 'You cannot raise your hand');
    if (!found) return;
    if (typeof payload.raised !== 'boolean') return sendError(ctx.ws, 'INVALID_PAYLOAD', 'raised must be true or false');
    if (!this.allowAction(ctx, found.participant)) return;
    found.room.setHand(found.participant.userId, payload.raised);
  }

  lowerHand(ctx, payload) {
    const found = this.authorize(ctx, ACTIONS.MODERATE, 'Only the host or a moderator can lower someone else\'s hand');
    if (!found || !this.allowAction(ctx, found.participant)) return;
    const target = this.moderationTarget(ctx, payload, found);
    if (target) found.room.setHand(target.userId, false);
  }

  // ---------- screen share presenter slot ----------

  async screenShareRequest(ctx) {
    const found = this.authorize(ctx, ACTIONS.SHARE_SCREEN, 'You cannot share your screen');
    if (!found || !this.allowAction(ctx, found.participant)) return;
    const { room, participant } = found;

    // Claim the slot first (synchronously), then ask the SFU to allow publishing.
    const claim = room.requestShare(participant.userId);
    if (claim.error) return sendError(ctx.ws, 'SHARE_IN_USE', 'Someone else is already sharing their screen');

    const allowed = await this.trySfu('setScreenSharePermission', () =>
      this.sfu.setScreenSharePermission(room.roomId, participant.userId, true)
    );
    if (!allowed) {
      room.releasePresenter(participant.userId, 'sfu_failed', { silent: true });
      return sendError(ctx.ws, 'SFU_UNAVAILABLE', 'Could not start screen sharing. Check your media connection and try again');
    }
    if (room.presenterId !== participant.userId) {
      // They left or were stopped while we waited for the SFU: take the permission back.
      this.trySfu('revoke', () => this.sfu.stopScreenShare(room.roomId, participant.userId));
      return undefined;
    }
    participant.send('screen_share_granted', {});
    room.broadcast('screen_share_changed', { userId: participant.userId });
    return undefined;
  }

  screenShareStop(ctx) {
    const found = this.member(ctx);
    if (!found) return;
    found.room.releasePresenter(found.participant.userId, 'stopped');
  }

  stopScreenShareFor(ctx, payload) {
    const found = this.authorize(ctx, ACTIONS.MODERATE, 'Only the host or a moderator can stop a screen share');
    if (!found || !this.allowAction(ctx, found.participant)) return;
    const target = this.moderationTarget(ctx, payload, found);
    if (!target) return;
    if (found.room.presenterId !== target.userId) {
      return sendError(ctx.ws, 'INVALID_TARGET', 'That person is not sharing their screen');
    }
    found.room.releasePresenter(target.userId, 'stopped_by_moderator');
    target.send('screen_share_stopped', { by: found.participant.userId });
    return undefined;
  }

  // ---------- moderation ----------

  async muteParticipant(ctx, payload) {
    const found = this.authorize(ctx, ACTIONS.MODERATE, 'Only the host or a moderator can mute people');
    if (!found || !this.allowAction(ctx, found.participant)) return;
    const target = this.moderationTarget(ctx, payload, found);
    if (!target) return;

    // Mute on the SFU (so it cannot be skipped), and ask the target's app to reflect it.
    const enforced = await this.trySfu('muteMicrophone', () => this.sfu.muteMicrophone(found.room.roomId, target.userId));
    target.send('force_muted', { by: found.participant.userId, byName: found.participant.username });
    if (!enforced) {
      sendError(ctx.ws, 'SFU_UNAVAILABLE', 'The person was asked to mute, but the media server could not enforce it');
    }
  }

  async removeParticipant(ctx, payload) {
    const found = this.authorize(ctx, ACTIONS.REMOVE_PARTICIPANT, 'Only the host or a moderator can remove people');
    if (!found) return;
    const target = this.moderationTarget(ctx, payload, found);
    if (!target) return;
    found.room.kick(target.userId);
    await this.trySfu('removeParticipant', () => this.sfu.removeParticipant(found.room.roomId, target.userId));
  }

  async assignRole(ctx, payload) {
    const found = this.authorize(ctx, ACTIONS.ASSIGN_ROLE, 'Only the host can change roles');
    if (!found) return;
    if (payload.role !== ROLES.MODERATOR && payload.role !== ROLES.PARTICIPANT) {
      return sendError(ctx.ws, 'INVALID_PAYLOAD', 'role must be "moderator" or "participant"');
    }
    const target = this.hostTarget(ctx, payload, found);
    if (!target || target.role === payload.role) return;
    found.room.assignRole(target.userId, payload.role);
    await this.trySfu('updateRole', () => this.sfu.updateRole(found.room.roomId, target.userId, payload.role));
  }

  transferHost(ctx, payload) {
    const found = this.authorize(ctx, ACTIONS.TRANSFER_HOST, 'Only the host can transfer the host role');
    if (!found) return;
    const target = this.hostTarget(ctx, payload, found);
    if (target) found.room.transferHost(target.userId);
  }

  setLocked(ctx, locked) {
    const found = this.authorize(ctx, ACTIONS.LOCK_ROOM, 'Only the host can lock the meeting');
    if (found) found.room.setLocked(locked);
  }

  async endMeeting(ctx) {
    const found = this.authorize(ctx, ACTIONS.END_MEETING, 'Only the host can end the meeting');
    if (!found) return;
    await this.lifecycle.endMeeting(found.room.roomId);
  }
}
