# Interview guide

Short, honest answers. Read the code behind each one so you can point at it.

**How does WebRTC work?** Two peers exchange connection details (SDP offer and answer, plus ICE candidates) through a signaling channel, test network paths with ICE, then send encrypted audio and video directly. In Huddle the "other peer" is the SFU, not another person.

**What is signaling, and why not use the app WebSocket for it?** Signaling is the exchange of connection details. The LiveKit SDK does it with the SFU, so our WebSocket only carries app events (presence, chat, hands, moderation). That keeps one clear responsibility per channel and means we never relay SDP ourselves.

**Why WebSockets for the app events?** They are push-based and two-way, so a hand raise or a mute reaches everyone at once without polling. We use the native browser `WebSocket` and the `ws` library, no Socket.IO.

**How do ICE, STUN and TURN work?** ICE tries candidate paths. STUN tells a browser its public address. TURN relays media when no direct path exists (strict networks). STUN alone does not guarantee connectivity, so production needs TURN.

**Why not a mesh?** It needs `N(N−1)/2` connections and each person uploads their video N−1 times (4,950 connections for 100 people). An SFU receives each stream once and forwards it. See `docs/sfu-architecture.md` for the table.

**What is an SFU and how do publish/subscribe work?** A Selective Forwarding Unit forwards media packets without decoding them. A participant publishes tracks to it; other participants subscribe to the tracks they want. Our client sets `autoSubscribe: false` and subscribes per track.

**What are simulcast and dynacast?** Simulcast: the sender publishes several sizes of the same video; the SFU sends each viewer the size that fits their tile. Dynacast: the SFU tells the sender to stop sending sizes nobody watches.

**How do you handle large meetings and active speakers?** The `SubscriptionPlanner` (pure and unit tested) picks whose video and audio to receive: the screen share, the pinned person, the active speaker, the current gallery page, and the most recent speakers for audio above 25 people. The active speaker comes from the SFU. Off-screen and camera-off people are not subscribed.

**How do tokens and grants enforce permissions?** The server mints the SFU token with `identity = userId`, the role in metadata, a short TTL and a limited grant (no admin, no data publish, no screen share). Admin actions (mute, remove, end) are made by the server with the API key after the app-level role check.

**Why does the server gate SFU tokens through room membership?** So lock, capacity and removal rules cannot be bypassed by asking the media server directly. A token is only issued to someone who is currently in the in-memory room.

**How does the presenter slot work?** `Room.requestShare()` is a synchronous check-and-set, so two requests cannot both win. The server then grants the screen-share source on the SFU. Stopping or leaving revokes it, and a webhook is a safety net.

**How does authentication work?** Passwords are bcrypt hashed; login returns a JWT with only the user id. REST routes verify it and load the user.

**How does WebSocket authentication work?** Browsers cannot set headers on `new WebSocket()` and a JWT in a URL leaks into logs. So the client trades the JWT for a 30-second, single-use ticket bound to one user and one meeting, checked and deleted during the upgrade.

**How is RBAC enforced?** One permission table in `constants.js`, checked on every event after "in the meeting". Identity comes from the ticket, never from the message. `canModerate` limits Moderators to Participants. The UI only hides buttons.

**How do you prevent a capacity race?** `Room.join()` checks and inserts in one synchronous step, and a returning member reuses their seat. A test fires 8 simultaneous joins at a capacity of 3 and exactly 3 succeed.

**How does reconnection work?** The app socket keeps the seat for 45 s and reconnects with backoff and a fresh ticket. The SDK handles short media blips; after a full media disconnect the client retries with a fresh SFU token (max 5 times) unless the reason is final.

**How are media resources cleaned up?** Leaving disconnects the room (which stops the camera and microphone), detaches and removes audio elements, clears timers and listeners. Media streams are kept in refs, not React state.

**How would you scale to many app servers and SFU nodes?** Redis Pub/Sub for room broadcasts across API instances, shared tickets and room ownership, and LiveKit's own multi-node mode for SFUs behind a load balancer. All broadcasts already go through `Room`, so that layer is added in one place. It is not built.

**What would you say about testing?** The server logic is tested with real WebSocket clients and a real SFU with headless participants. Browser media (camera, screen capture), mobile, TURN across real networks, real MongoDB and deployment need a manual run. The largest load actually run was 30 headless audio bots, not 100.

**A problem I ran into (from a real bug report):** people were in the meeting but media said "Media failed", because LiveKit was not running and the error was just "unavailable". I captured the real error shapes from the SDK (connection refused vs. 401 Unauthorized), added a `/api/health/media` check, a startup warning and messages that say which problem it is, plus a Retry button so a user does not have to leave. **Another:** a test showed the Host could not re-enter their own meeting after it was locked and unloaded; the lock check now lets the Host in. Also, a kicked user's closing socket briefly started a pointless grace timer; the guard in `Room.disconnect` fixes it.
