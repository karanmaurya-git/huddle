export const ROLES = Object.freeze({
  HOST: 'host',
  MODERATOR: 'moderator',
  PARTICIPANT: 'participant',
});

export const ACTIONS = Object.freeze({
  CHAT: 'chat',
  RAISE_HAND: 'raise_hand',
  SHARE_SCREEN: 'share_screen',
  MODERATE: 'moderate', // mute / lower hand / stop screen share of someone else
  REMOVE_PARTICIPANT: 'remove_participant',
  ASSIGN_ROLE: 'assign_role',
  TRANSFER_HOST: 'transfer_host',
  LOCK_ROOM: 'lock_room',
  END_MEETING: 'end_meeting',
});

// The one place that defines who may do what. The backend checks this on every event.
const PERMISSIONS = {
  [ROLES.HOST]: new Set(Object.values(ACTIONS)),
  [ROLES.MODERATOR]: new Set([
    ACTIONS.CHAT,
    ACTIONS.RAISE_HAND,
    ACTIONS.SHARE_SCREEN,
    ACTIONS.MODERATE,
    ACTIONS.REMOVE_PARTICIPANT,
  ]),
  [ROLES.PARTICIPANT]: new Set([ACTIONS.CHAT, ACTIONS.RAISE_HAND, ACTIONS.SHARE_SCREEN]),
};

export const can = (role, action) => Boolean(PERMISSIONS[role]?.has(action));
export const isPrivileged = (role) => role === ROLES.HOST || role === ROLES.MODERATOR;

/**
 * Whether `actor` may moderate `target` (mute, lower hand, stop share, remove).
 * The Host can act on anyone except themselves. A Moderator can only act on Participants,
 * never on the Host or on another Moderator.
 */
export function canModerate(actor, target) {
  if (actor.userId === target.userId) return false;
  if (actor.role === ROLES.HOST) return true;
  return actor.role === ROLES.MODERATOR && target.role === ROLES.PARTICIPANT;
}

export const CLOSE = Object.freeze({
  NORMAL: 1000,
  REMOVED: 4001,
  REPLACED: 4002,
  NOT_FOUND: 4004,
  MEETING_ENDED: 4005,
  JOIN_TIMEOUT: 4008,
});

export const LIMITS = Object.freeze({
  MAX_MESSAGE_BYTES: 16 * 1024,
  MAX_CHAT_LENGTH: 500,
  CHAT_HISTORY: 100,
  MESSAGES_PER_SECOND: 40,
  JOIN_TIMEOUT_MS: 10_000,
  HEARTBEAT_MS: 30_000,
});

// Tunable in tests via RoomManager options.
export const DEFAULT_OPTIONS = Object.freeze({
  disconnectGraceMs: 45_000,
  emptyRoomMs: 60_000,
});
