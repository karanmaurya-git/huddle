# WebRTC flow

## The short version

1. The browser asks the app server for a token (only allowed for current meeting members).
2. `livekit-client` opens a signaling WebSocket to the SFU and negotiates **one** WebRTC connection (a publisher and a subscriber transport) with it.
3. The browser publishes its microphone and camera to the SFU **once**. The SFU forwards that stream to whoever subscribes.
4. The browser chooses what to receive (see the subscription strategy). It never connects to other participants directly.

```text
Participant A ── publish ──▶ SFU ── forward ──▶ Participant B
                              │
                              └─ forward ──▶ Participant C
```

## Signaling, ICE, STUN and TURN

- **Signaling** is how two sides exchange connection details (SDP offer/answer and ICE candidates). Here the LiveKit SDK does it with the SFU. Our application WebSocket is not used for it.
- **ICE** tries several network paths between the browser and the SFU and picks one that works.
- **STUN** tells a browser its public address. It works on most home networks.
- **TURN** relays media when no direct path exists (strict corporate Wi-Fi, some mobile networks). Without TURN, those users cannot connect. STUN alone does not guarantee connectivity. LiveKit includes a TURN server you enable in `deploy/livekit.yaml`; LiveKit Cloud provides it for you.

## Publish and subscribe

```text
connect(url, token, { autoSubscribe: false })
setMicrophoneEnabled(true) / setCameraEnabled(true)      -> publish (camera uses simulcast)
for each remote track: publication.setSubscribed(true|false)   <- decided by the SubscriptionPlanner
```

- Toggling the microphone or camera does not tear down the connection.
- **Simulcast**: the camera is published in a few sizes (180p, 360p, 720p). The SFU sends each viewer the size that fits their tile.
- **Adaptive stream** (`adaptiveStream: true`): the SDK picks a quality from the size of the video element and pauses video that is not visible.
- **Dynacast** (`dynacast: true`): the SFU tells a publisher to stop sending layers nobody is watching.

## Screen sharing

1. The user clicks Share. The client sends `screen_share_request` over the app WebSocket.
2. If the slot is free, the server grants the `screen_share` source to that participant on the SFU and replies `screen_share_granted`.
3. Only then does the client call `setScreenShareEnabled(true)` and open the browser's screen picker.
4. Stopping (our button, the browser's own "Stop sharing", a moderator, leaving or a dropped connection) releases the slot and the server revokes the permission.

## Reconnection

| Layer | What happens |
|---|---|
| Short network blip | The SDK retries on its own (`Reconnecting`, then `Reconnected`); tiles show a "reconnecting" state. |
| Media fully disconnected | `decideRecovery`: stop if the reason is final (removed, replaced, room deleted), otherwise retry with exponential backoff and a **fresh token** (max 5 attempts), then show "Media connection lost". |
| App WebSocket dropped | Reconnects with backoff and a fresh ticket. The seat is kept for 45 s. The media connection is not torn down just because the app socket dropped. |
| Same user opens a second tab | The newer app connection replaces the older (close 4002); the SFU disconnects the older media session (duplicate identity). |

## Clean-up

On leaving or unmounting: the room is disconnected (this stops the camera and microphone), `<audio>` elements are detached and removed, listeners and timers are cleared. Media streams live in refs, not React state, so video frames never cause re-renders.
