# SFU architecture

## Why an SFU and not a mesh

In a full mesh every participant connects to every other one: `N × (N − 1) / 2` connections.

| Participants | Connections | Uploads per person |
|---:|---:|---:|
| 4 | 6 | 3 |
| 6 | 15 | 5 |
| 10 | 45 | 9 |
| 20 | 190 | 19 |
| 50 | 1,225 | 49 |
| 100 | 4,950 | 99 |

With an SFU (Selective Forwarding Unit) every participant uploads **once** and the SFU forwards each stream to the people who want it. The SFU does not mix or re-encode video, so it stays cheap compared with an MCU.

```text
mesh (N = 4)                    SFU (N = 4)
A ─ B                           A ─┐
A ─ C                           B ─┼─ SFU ─┐ forwards to subscribers
A ─ D                           C ─┤       │
B ─ C                           D ─┘       └─▶ A, B, C, D (only what each one asked for)
B ─ D
C ─ D
```

## Why LiveKit

- Open source (Apache-2.0) SFU with simulcast, dynacast, adaptive streaming, active-speaker detection, built-in TURN, server-side track and permission control, and an SDK that reconnects on its own.
- Self-hostable (one binary or Docker image) or available as LiveKit Cloud, so it can be deployed by one person.
- **It can be tested end to end without a browser**: the build used a real `livekit-server` and headless `@livekit/rtc-node` participants. mediasoup and Janus would need a browser-based client for the same level of verification.
- Trade-off, said plainly: mediasoup gives deeper control and teaches more about transports, producers and consumers, but needs native builds, hand-written signaling and hosting with a UDP port range. LiveKit was chosen for reliable delivery and testability.

All SFU access goes through `server/src/sfu/SfuProvider.js`. `LiveKitProvider.js` is the only file that imports `livekit-server-sdk`, so another SFU could replace it by implementing the same interface.

## What the app server controls on the SFU

| Action | Call (inside `LiveKitProvider`) |
|---|---|
| Let someone connect | `AccessToken` with the grants below |
| Create the room with a capacity backstop | `createRoom({ name, maxParticipants, ... })` (idempotent) |
| Force-mute a microphone | find the microphone track, then `mutePublishedTrack` |
| Remove a participant | `removeParticipant` |
| End a meeting | `deleteRoom` |
| Give or take away screen sharing | `updateParticipant` with a new permission |
| Reflect a role change | `updateParticipant` metadata |
| Verify SFU events | `WebhookReceiver` |

### Token grants (security-critical)

- `identity = userId`, `name = username`, `metadata = { role }`, set only by the server. Short TTL (`SFU_TOKEN_TTL_SECONDS`, default 600): a token is only needed to connect.
- `canSubscribe: true`, `canPublish: true`, `canPublishData: false` (chat uses the app WebSocket), `canPublishSources: [camera, microphone]`.
- Screen sharing is **not** in the default grant. It is added only for the single presenter.
- **Never** granted to a browser: `roomAdmin`, `roomCreate`, `roomList`, `roomRecord`. All admin actions are made by the server after the app-level role check.
- A token is only issued to a current member of the in-memory room, so lock, capacity and removal rules cannot be bypassed.

### Presenter slot

`Room.requestShare()` is a synchronous check-and-set. After winning it, the handler calls `setScreenSharePermission(true)`; on failure the slot is freed and the user gets `SFU_UNAVAILABLE`. Release triggers: stop, leave, disconnect, moderator stop, or the webhook reporting `track_unpublished` (screen share) or `participant_left`. Webhook handling is idempotent. If webhooks are not configured, the app still works: leaving or disconnecting frees the slot directly.

## Large-meeting strategy

Capacity means "people allowed in the meeting". It does not mean everyone receives everyone's video. The client connects with `autoSubscribe: false` and a pure planner (`client/src/meeting/subscriptionPlanner.js`, unit tested) decides the subscriptions:

| Layout | Video subscriptions | Notes |
|---|---|---|
| Speaker view | the stage (screen share, else pinned, else active/recent speaker, else someone with a camera) plus up to 8 strip tiles (recent speakers first, then cameras on) | camera-off people are never subscribed |
| Gallery view | only the cameras on the current page (default 12 per page) | pagination controls |
| Screen share | the sharer's screen has the highest priority and forces speaker view | |

Audio: with 25 people or fewer, listen to everyone. Above that, listen to the 10 most relevant (pinned, presenter, stage, then most recent speakers). The active speaker comes from the SFU, so a new speaker is added within a moment. Subscription changes are throttled (400 ms), but a screen-share change applies immediately.

The People list is windowed (only visible rows render), so 100 entries stay smooth.

**Honest limits:** real capacity depends on the SFU host (CPU, bandwidth), the network and the devices. This project is **designed and configured** for up to 100 participants per meeting at the application level. The largest participant count actually tested is **30 headless audio bots** (see [requirements.md](requirements.md)). A real 100-participant test was not performed.

## Scaling the SFU

LiveKit can run several nodes behind Redis and routes each room to a node. This project does not implement or test that. See the scaling path in [architecture.md](architecture.md).
