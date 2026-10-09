# Architecture

Huddle separates the **control plane** (who is in the meeting and what they may do) from the **media plane** (audio and video).

```text
                     ┌──────────────────────────┐
                     │       React client        │
                     │  UI · state · livekit-client │
                     └──┬────────────┬───────────┘
          REST (HTTPS)  │            │  WebSocket (WSS, native)         WebRTC media
                        ▼            ▼                                      │
              ┌────────────────────────────────┐                            ▼
              │   Node.js server (Render)       │   server API    ┌──────────────────┐
              │   Express REST + ws WebSocket   │ ──────────────▶ │   LiveKit SFU     │
              │   auth · rooms · RBAC · chat    │ ◀── webhooks ── │  forwards media,  │
              │   presence · moderation         │                 │  simulcast,       │
              └───────────────┬────────────────┘                 │  active speakers  │
                              ▼                                   └────────┬─────────┘
                        MongoDB Atlas                             browsers ◀──▶ SFU
```

- **REST** handles things that happen once: register, log in, create, look up, list and delete meetings, get a WebSocket ticket, get an SFU token.
- **WebSocket** (`ws` on the server, native `WebSocket` in the browser) carries only application events: presence, chat, raise hand, moderation, the screen-share slot. It never carries media or SDP/ICE.
- **WebRTC through the SFU** carries microphone, camera and screen audio/video. The LiveKit SDK negotiates WebRTC with the SFU itself.

## Who is the source of truth

| Topic | Owner |
|---|---|
| Membership, roles, capacity, lock, removed users, meeting lifecycle | App server (in memory, saved to MongoDB when needed) |
| Chat, raised hands, who is presenting | App server |
| Mic, camera, screen-share on/off, who is speaking, connection quality | LiveKit (the client reads it from the SDK; it is not duplicated over the app WebSocket) |
| Identity of a media participant | `identity = userId`, set by the app server when it mints the token |

## Server layers

```text
ws WebSocketServer (same HTTP server as Express, noServer + upgrade, no custom path)
   -> MessageHandler   parse, validate, authorize, delegate, per-socket message queue
   -> RoomManager      active rooms in memory, load/unload from MongoDB, wires SFU hooks
   -> Room             participants, roles, hand queue, presenter slot, chat, broadcasting
   -> Participant      userId, username, role, socket, rate limiters
sfu/ SfuProvider (interface) -> LiveKitProvider (the only file that imports livekit-server-sdk)
```

`Room.broadcast()`, `broadcastExcept()`, `broadcastToPrivileged()` and `Participant.send()` are the only callers of `ws.send`. A Redis Pub/Sub layer for several server instances would be added there.

## Connecting and joining

1. `POST /api/auth/ws-ticket {roomId}` with the JWT returns a 30-second, single-use ticket bound to that user and meeting.
2. The browser opens `new WebSocket(wss://host/?ticket=...)`. The upgrade handler checks `Origin` and consumes the ticket before the socket exists (401 if invalid, 403 for a bad origin).
3. The client sends `join_room`. The server checks lock, capacity and the removed list, then `Room.join()` (synchronous, so capacity cannot race) and replies `room_joined`.
4. The client calls `POST /api/meetings/:code/sfu-token`. A token is issued **only** to someone who is currently a member of the in-memory room.
5. `livekit-client` connects to the SFU with the token. Joining the app first is what makes lock, capacity and removal impossible to bypass through the media server.

## Meeting lifecycle

- **Capacity** (`MAX_PARTICIPANTS`, default 100): enforced at `join_room`. A reconnecting member keeps their seat and uses no second slot.
- **Lock**: new joiners get `ROOM_LOCKED`; existing members and reconnects are unaffected; the Host can always enter.
- **Grace period (45 s)**: a dropped socket keeps its seat and role; after expiry the person is removed (`user_left`, `reason: "timeout"`).
- **Host succession**: if the Host is removed or expires, the longest-present Moderator (else Participant, connected ones first) becomes Host.
- **Empty meeting**: unloaded from memory after 60 s but kept in MongoDB; the next join rehydrates it and the creator regains Host.
- **End / delete** (Host only): everyone gets `meeting_ended`, sockets close with 4005, the SFU room is deleted, MongoDB is updated (`ended`) or the record removed (delete).
- **MongoDB writes** happen only on create, host change, lock change, end/delete, unload and join (for "recent meetings"), never on chat, hands, mute or media events.

## Screen-share presenter slot

By default nobody may publish a screen. `screen_share_request` claims the single slot in one synchronous step (two simultaneous requests cannot both win), then the server grants the `screen_share` source to that participant on the SFU. Releasing the slot (stop, leave, disconnect, moderator stop, or the SFU reporting the track gone) takes the permission away again. Details in [sfu-architecture.md](sfu-architecture.md).

## Large meetings

The client never subscribes to everyone. A pure `SubscriptionPlanner` decides whose video and audio to receive (screen share, pinned person, active speaker, current gallery page, top-N recent speakers for audio). See [sfu-architecture.md](sfu-architecture.md).

## Scaling path (documented, not built)

```text
                    Load balancer
                          |
          ┌───────────────┼───────────────┐
        API #1          API #2          API #3
          └───────────────┼───────────────┘
                        Redis (Pub/Sub, shared presence, tickets)
          ┌───────────────┼───────────────┐
        SFU #1          SFU #2          SFU #3   (LiveKit's own distributed mode)
```

Today it is one app server process with in-memory rooms. To scale out, add Redis Pub/Sub so a broadcast on one API instance reaches sockets on the others, move tickets and room ownership to Redis (or route each room to one instance), and run several SFU nodes. Mongoose's default connection pool handles MongoDB connections. None of this is implemented.
