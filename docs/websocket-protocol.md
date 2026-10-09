# WebSocket protocol (application events only)

Media and WebRTC signaling are **not** carried here. They go through the LiveKit SFU.

## Connection

```text
wss://YOUR-SERVER.onrender.com/?ticket=<ticket>
```

1. `POST /api/auth/ws-ticket` with `Authorization: Bearer <JWT>` and body `{ "roomId": "ABC234" }`.
2. A ticket is random, valid 30 seconds, single use, bound to one user and one meeting, and kept in server memory.
3. A missing, unknown, used or expired ticket gets HTTP 401 and no WebSocket is created. A bad `Origin` gets 403.
4. After connecting, send `join_room` within 10 seconds or the socket closes (4008).
5. Request a **fresh ticket for every connect and reconnect**.

Every message in both directions is `{ "type": "...", "payload": { ... } }`. `payload` must be an object. Max 16 KB per message, 40 messages per second per socket. The server sets `userId`, `username` and role from its own state; client-supplied identity is never used.

## Client to server

| type | payload | Allowed |
|---|---|---|
| `join_room` | `{ roomId }` (must equal the ticket's meeting) | authenticated |
| `leave_room` | `{}` | member |
| `chat_message` | `{ message }`, 1 to 500 characters after trim | member |
| `raise_hand` | `{ raised: boolean }` | member (own) |
| `lower_hand` | `{ userId }` | Host, Moderator (on Participants) |
| `screen_share_request` | `{}` | member |
| `screen_share_stop` | `{}` | the presenter |
| `stop_screen_share_for` | `{ userId }` | Host, Moderator (on Participants) |
| `mute_participant` | `{ userId }` | Host, Moderator (on Participants) |
| `remove_participant` | `{ userId }` | Host (anyone), Moderator (Participants only) |
| `assign_role` | `{ userId, role: "moderator" \| "participant" }` | Host |
| `transfer_host` | `{ userId }` | Host |
| `lock_room`, `unlock_room` | `{}` | Host |
| `end_meeting` | `{}` | Host |

"Moderate" rules: the Host can act on anyone except themselves; a Moderator can only act on Participants, never on the Host or another Moderator.

## Server to client

| type | payload | Sent to |
|---|---|---|
| `room_joined` | `{ roomId, you, participants, chat, locked, capacity, count, presenterId, reconnected }` | the joiner |
| `user_joined` | `{ userId, username, role, participants, count }` | everyone except the joiner |
| `user_left` | `{ userId, username, reason: "left" \| "timeout", participants, count }` | room |
| `participant_removed` | `{ userId, username, participants, count }` | room |
| `removed_from_room` | `{ roomId, message }` | the removed person (socket then closes 4001) |
| `role_assigned` | `{ userId, username, role, participants }` | room |
| `host_transferred` | `{ oldHostId, newHostId, newHostName, reason: "transfer" \| "succession", participants }` | room |
| `hand_changed` | `{ userId, raised, at }` | room |
| `screen_share_granted` | `{}` | the requester (they may now open the screen picker) |
| `screen_share_changed` | `{ userId \| null }` | room |
| `screen_share_stopped` | `{ by }` | the presenter, when a moderator stopped them |
| `force_muted` | `{ by, byName }` | the muted person |
| `room_lock_changed` | `{ locked }` | room |
| `meeting_ended` | `{ roomId, message }` | everyone (sockets then close 4005) |
| `chat_message` | `{ id, userId, username, message, timestamp }` | room |
| `error` | `{ code, message }` | the sender only |

A participant is `{ userId, username, role, handRaised, handRaisedAt, joinedAt }`, ordered Host, Moderators, Participants.

## Validation order

```text
authenticated (ticket) -> in the meeting -> role allowed -> target exists -> target valid -> act -> broadcast
```

## Error codes

`INVALID_JSON`, `INVALID_MESSAGE`, `UNKNOWN_EVENT`, `NOT_IN_ROOM`, `ALREADY_JOINED`, `ROOM_MISMATCH`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `ROOM_LOCKED`, `REMOVED`, `MEETING_ENDED`, `FORBIDDEN`, `INVALID_PAYLOAD`, `INVALID_TARGET`, `TARGET_NOT_FOUND`, `SHARE_IN_USE`, `SFU_UNAVAILABLE`, `RATE_LIMITED`, `INTERNAL_ERROR`.

## Close codes

| Code | Meaning | Client |
|---|---|---|
| 1000 | normal, left, or a join refused (`ROOM_FULL`, `ROOM_LOCKED`) | do not reconnect |
| 4001 | removed | do not reconnect |
| 4002 | replaced by a newer connection of the same user | do not reconnect |
| 4004 | meeting not found | do not reconnect |
| 4005 | meeting ended or deleted | do not reconnect |
| 4008 | no `join_room` within 10 s | reconnect |
| other | network drop | reconnect with backoff (1, 2, 4, 8, 10 s) and a fresh ticket |

## Heartbeat and reconnect

The server sends a WebSocket ping every 30 seconds and terminates sockets that never answered. A dropped socket keeps its seat and role for **45 seconds**; reconnecting with a fresh ticket restores them (`room_joined` with `reconnected: true`). The media connection reconnects separately, with a fresh SFU token (see [webrtc-flow.md](webrtc-flow.md)).
