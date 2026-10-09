# REST API

All responses are `{ "success": true, ... }` or `{ "success": false, "message": "...", "code"?: "..." }`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/register` | none | `{ name, email, password }`, returns `{ token, user }` (201) |
| POST | `/api/auth/login` | none | `{ email, password }`, returns `{ token, user }` |
| POST | `/api/auth/logout` | none | stateless; the client drops its token |
| POST | `/api/auth/ws-ticket` | JWT | `{ roomId }`, returns `{ ticket, expiresIn }` |
| POST | `/api/meetings` | JWT | `{ title? }`, creates a meeting, returns `{ meeting: { code, ... } }` (201) |
| GET | `/api/meetings` | JWT | recent meetings you hosted or joined (newest first, max 20) |
| GET | `/api/meetings/:code` | JWT | `{ code, title, status, locked, count, capacity, isHost }` |
| POST | `/api/meetings/:code/sfu-token` | JWT, current member | `{ token, url }` for the media server |
| DELETE | `/api/meetings/:code` | JWT, current Host | deletes the meeting; everyone inside is disconnected |
| POST | `/api/sfu/webhook` | LiveKit signature | receives SFU events (raw body) |
| GET | `/api/health` | none | `{ "success": true, "message": "Server is running" }` |
| GET | `/api/health/media` | none | is the media server reachable with our credentials? `200 { success: true, sfu: "reachable" }`, or `503 { success: false, sfu: "unreachable", reason }` (`reason` is `unreachable`, `bad_credentials` or `other`; outside production it also has a `hint` that says what to fix) |

Joining and leaving a meeting happens over the WebSocket, not REST.

## Status codes

`200`, `201` (created), `400` (invalid input), `401` (not logged in, bad credentials or bad webhook signature), `403` (not allowed: not the host, not a member, removed, origin blocked), `404` (not found), `409` (email already registered), `410` (the meeting has ended), `429` (rate limited), `500`, `503` (`code: "SFU_UNAVAILABLE"`, the media server cannot be reached).

## Rules

- Meeting code: 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, unique (collision checked).
- Register: name 2 to 50 characters, a valid email, password 8 to 100 characters.
- `sfu-token` is refused unless the caller is currently a member of the live meeting (not removed, not ended). Tokens carry `identity = userId`, the server-decided role in metadata, a short TTL, and never any admin permission.
- Rate limits: `/api/auth` 100 per 15 minutes per IP (`AUTH_RATE_LIMIT_MAX`), the rest of the meeting API 600 per 15 minutes.
