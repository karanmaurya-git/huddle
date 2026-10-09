// State owned by the app WebSocket: who is here, roles, hands, chat, lock, presenter.
// Media state (mic, camera, speaking) is NOT here; it comes from the SFU connection.

export const initialState = {
  status: 'connecting', // connecting | connected | reconnecting | removed | replaced | ended | notfound | full | locked | error
  notice: '',
  me: null,
  participants: [],
  chat: [],
  locked: false,
  capacity: 0,
  count: 0,
  presenterId: null,
};

const ERROR_STATUS = {
  ROOM_FULL: 'full',
  ROOM_LOCKED: 'locked',
  MEETING_ENDED: 'ended',
  ROOM_NOT_FOUND: 'notfound',
  REMOVED: 'removed',
};

/** The server is the source of truth: my own role is always read back from the list. */
function withParticipants(state, participants, extra = {}) {
  const self = participants.find((p) => p.userId === state.me?.userId);
  return {
    ...state,
    ...extra,
    participants,
    me: self && state.me ? { ...state.me, role: self.role } : state.me,
  };
}

export function applyServerMessage(state, { type, payload }) {
  switch (type) {
    case 'room_joined':
      return {
        ...state,
        status: 'connected',
        notice: '',
        me: payload.you,
        participants: payload.participants,
        chat: payload.chat,
        locked: payload.locked,
        capacity: payload.capacity,
        count: payload.count,
        presenterId: payload.presenterId,
      };
    case 'user_joined':
    case 'user_left':
    case 'participant_removed':
      return withParticipants(state, payload.participants, { count: payload.count });
    case 'role_assigned':
    case 'host_transferred':
      return withParticipants(state, payload.participants);
    case 'hand_changed':
      return withParticipants(
        state,
        state.participants.map((p) =>
          p.userId === payload.userId ? { ...p, handRaised: payload.raised, handRaisedAt: payload.at } : p
        )
      );
    case 'screen_share_changed':
      return { ...state, presenterId: payload.userId };
    case 'room_lock_changed':
      return { ...state, locked: payload.locked };
    case 'chat_message':
      return { ...state, chat: [...state.chat, payload].slice(-200) };
    case 'removed_from_room':
      return { ...state, status: 'removed', notice: payload.message };
    case 'meeting_ended':
      return { ...state, status: 'ended', notice: payload.message };
    case 'error': {
      const status = ERROR_STATUS[payload.code];
      return status ? { ...state, status, notice: payload.message } : state;
    }
    default:
      return state;
  }
}

export function reducer(state, action) {
  switch (action.type) {
    case 'status':
      return { ...state, status: action.status };
    case 'fatal':
      return { ...state, status: action.status, notice: state.status === action.status ? state.notice : action.notice || '' };
    case 'server':
      return applyServerMessage(state, action.message);
    default:
      return state;
  }
}
