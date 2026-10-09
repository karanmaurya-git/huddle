# Requirements and verification status

Status labels:

- **AUTOMATED-TESTED**: a test for it was actually run and passed.
- **BUILT**: implemented, but no automated test exercises it end to end.
- **MANUAL-VERIFICATION-REQUIRED**: needs a real browser, device, network or deployment, which the build environment did not have.
- **NOT IMPLEMENTED**: not built.

A feature is only marked tested when a test was executed successfully. Mocks and fakes exist only inside tests.

## Test runs (this build)

| Suite | Result |
|---|---|
| Server unit, REST and real-WebSocket tests (`cd server && npm test`) | **76 passed**. Mongoose models are replaced by in-memory fakes; the SFU is replaced by a recorder that still signs real tokens |
| Real SFU integration tests (`npm run test:sfu`) against a real `livekit-server` v1.13.7 with headless `@livekit/rtc-node` participants | **11 passed** plus 1 end-to-end test that reproduces "media server down, then up" (12 in total), 1 placeholder skipped |
| Load test, default 12 bots through the real join flow | **passed** (12 of 12 connected, 9 of 9 listeners received audio) |
| Client logic and component tests (`cd client && npm test`) | **45 passed** (jsdom) |
| `vite build` | passed (main chunk ~330 kB; the meeting screen and media SDK load only when a meeting is opened) |

### Largest participant counts actually tested

| Bots (1 host, 3 audio publishers, the rest listeners) | Result in the 1-CPU build sandbox |
|---|---|
| 12 | all connected, all listeners received audio (stable, this is the default test) |
| 20 | all connected, 17 of 17 listeners received audio, connect time p50 about 1.3 s, p95 about 2.6 s |
| 30 | all 30 connected in two runs, no failures; audio reached 27 of 27 listeners in one run and 26 of 27 within 20 s in the other |
| 40 | did not finish within the test's 90 s limit |

The bots all run in one Node process on one CPU, so the **bots** are the bottleneck, not necessarily the SFU. These runs are audio only (no video load). **A real 100-participant test was not performed.** The application is designed and configured for up to 100 participants per meeting at the application level; real capacity depends on SFU infrastructure, CPU, memory, network bandwidth, devices, media configuration and the subscription strategy.

## Features

| Feature | Status | Notes |
|---|---|---|
| Register, log in, log out, JWT, bcrypt | AUTOMATED-TESTED | REST tests and login/register component tests. Real MongoDB: MANUAL-VERIFICATION-REQUIRED |
| Create, look up, list (recent), delete meetings; codes and invite links | AUTOMATED-TESTED | REST and WebSocket tests; dashboard component tests |
| Join, leave, reconnect, 45 s grace period, one socket per user | AUTOMATED-TESTED | real WebSocket clients |
| WebSocket tickets (single use, 30 s, room-bound, origin check) | AUTOMATED-TESTED | |
| Capacity (`MAX_PARTICIPANTS`), including a simultaneous-join race | AUTOMATED-TESTED | unit and WebSocket tests |
| Lock and unlock | AUTOMATED-TESTED | |
| Roles Host / Moderator / Participant enforced on the server | AUTOMATED-TESTED | permission matrix and WebSocket tests, forged events rejected |
| Mute, remove, assign/revoke Moderator, transfer Host, succession, end meeting | AUTOMATED-TESTED | |
| Force-mute on the real SFU | AUTOMATED-TESTED | `mutePublishedTrack` observed by another participant |
| Remove participant / delete room on the real SFU | AUTOMATED-TESTED | |
| Real audio forwarded through the SFU | AUTOMATED-TESTED | headless bot publishes a tone, another receives it. Video forwarding was **not** tested |
| Screen-share presenter slot (one at a time) | AUTOMATED-TESTED | server logic, and the real SFU refuses a screen-share track without the permission and accepts it with it. The browser screen picker: MANUAL-VERIFICATION-REQUIRED |
| SFU token grants (no admin grants, no data publish, short TTL, share withheld) | AUTOMATED-TESTED | |
| Token only for current members (not for non-members, removed users, locked-out newcomers, ended meetings) | AUTOMATED-TESTED | |
| Webhook handling (signature check, idempotent slot release) | AUTOMATED-TESTED | with an injected receiver. A real LiveKit webhook delivery: MANUAL-VERIFICATION-REQUIRED |
| Chat (validation, rate limit, room isolation, history) | AUTOMATED-TESTED | server; panel component test (plain-text rendering) |
| Raise hand and hand queue | AUTOMATED-TESTED | server and queue ordering |
| Subscription planner (speaker/gallery, paging, pinning, share priority, audio cap, throttling) | AUTOMATED-TESTED | pure logic. Applying subscriptions through the SDK in a browser: MANUAL-VERIFICATION-REQUIRED |
| Windowed People list for 100 people | AUTOMATED-TESTED | window maths and component test |
| Role-based UI (buttons per role) | AUTOMATED-TESTED | component tests mirror the server rules |
| Client reconnect backoff and media recovery decisions | AUTOMATED-TESTED | pure logic. A real browser reconnect (airplane mode): MANUAL-VERIFICATION-REQUIRED |
| Lobby fallbacks (no media API, blocked permissions, locked, full) | AUTOMATED-TESTED | component tests. Real camera preview and level meter: MANUAL-VERIFICATION-REQUIRED |
| Camera and microphone capture, mic/camera toggles, device selection | BUILT, MANUAL-VERIFICATION-REQUIRED | |
| Simulcast, adaptive stream, dynacast, active-speaker highlight, connection-quality dots | BUILT, MANUAL-VERIFICATION-REQUIRED | SDK settings and UI |
| Speaker and gallery layouts, pinning, pagination UI, floating self view | BUILT, MANUAL-VERIFICATION-REQUIRED | |
| Keyboard shortcuts (M, V, S, H, C, P, G) | BUILT, MANUAL-VERIFICATION-REQUIRED | |
| Responsive layout, animations, accessibility details | BUILT, MANUAL-VERIFICATION-REQUIRED | not viewed in a browser |
| Modern UI polish (auth, dashboard, lobby, meeting, notices) | BUILT, MANUAL-VERIFICATION-REQUIRED | `vite build` and component tests only |
| STUN/TURN across real networks | MANUAL-VERIFICATION-REQUIRED | TURN is configured in `deploy/livekit.yaml` (template, untested) |
| Docker Compose for local dev | BUILT, MANUAL-VERIFICATION-REQUIRED | not run (no Docker in the build environment) |
| Deployment to Vercel, Render, Atlas and an SFU host, HTTPS and WSS | MANUAL-VERIFICATION-REQUIRED | nothing was deployed |
| Real MongoDB behaviour (TTL index, upserts) | MANUAL-VERIFICATION-REQUIRED | schemas validated offline only |
| Large rooms with real video (100 people) | MANUAL-VERIFICATION-REQUIRED | see the load results above |
| Clear media-failure reporting: `/api/health/media`, a startup warning, and 503 messages that say whether LiveKit is unreachable or rejects the key (hint hidden in production) | AUTOMATED-TESTED | error shapes captured from the real SDK; an end-to-end test shows the failure, that chat still works, and recovery once LiveKit starts |
| "Retry" button on the media-failed banner (reconnect media without leaving the meeting) | BUILT, MANUAL-VERIFICATION-REQUIRED | the hook and banner were not exercised in a browser |
| Stats panel, shared notes (optional bonuses) | NOT IMPLEMENTED | skipped on purpose |
| Recording, waiting rooms, breakout rooms, virtual backgrounds, captions, persisted chat | NOT IMPLEMENTED | out of scope |
| Horizontal scaling (Redis Pub/Sub, several SFU nodes) | NOT IMPLEMENTED | documented only |

## Decisions where the brief was silent

- **Moderators can act only on Participants** (mute, remove, lower hand, stop share). They cannot act on the Host or another Moderator. The brief let Moderators remove people "if allowed"; this is the narrow, safe reading.
- **The Host can always enter their own meeting**, even if it was locked before it was unloaded from memory. Other former members cannot re-enter a locked, unloaded meeting, because membership is not stored in MongoDB.
- **Ended meetings stay in the recent list** as "Ended"; **Delete** removes the record (Host only). Ending is `end_meeting`; deleting is REST `DELETE`.
- **Joining refused for a full or locked meeting** sends an error and closes the socket with code 1000 (the client shows a dedicated screen).
- **A disconnected presenter loses the slot immediately**, instead of holding it for the 45 s grace period.
- **Plain CSS with variables** instead of Tailwind, and inline SVG icons instead of emoji, to keep the design consistent and dependencies small.
- **An in-meeting device switcher was not built.** Devices are chosen in the lobby.
