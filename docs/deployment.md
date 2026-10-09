# Deployment

The app has **four** pieces, and one of them cannot run on Render or Vercel:

| Piece | Where | Notes |
|---|---|---|
| Client (React) | Vercel | static build |
| App server (Express + ws) | Render | long-lived WebSockets are supported |
| Database | MongoDB Atlas | free tier is enough |
| **SFU (LiveKit)** | **LiveKit Cloud or a VPS** | needs media ports (UDP/TCP) and a public IP. Render and Vercel cannot host it |

Nothing here was deployed or tested in the build environment. Treat every step as unverified until you have tried it.

## 1. MongoDB Atlas

Create a free cluster and a database user. Under Network Access allow Render (`0.0.0.0/0` works). Copy the connection string (URL-encode special characters in the password).

## 2. The SFU (pick one)

**A. LiveKit Cloud (easiest).** Create a project. You get a `wss://...livekit.cloud` URL, an API key and a secret. Check the current free-tier limits. In LiveKit Cloud settings add the webhook URL `https://YOUR-SERVER.onrender.com/api/sfu/webhook`.

**B. Self-host on a VPS.** Use `deploy/livekit.yaml` as a template.

- Open: signaling (put a TLS reverse proxy such as Caddy in front, serving `wss://livekit.YOUR-DOMAIN.com`), TCP `7881` (fallback), UDP `7882` (media), and the TURN ports (`5349` TLS, `3478` UDP).
- Create your own API key and secret (long and random). Never reuse the dev credentials.
- Enable `turn` so people on strict networks can connect.

## 3. App server on Render

New Web Service from the repo.

| Setting | Value |
|---|---|
| Root directory | `server` |
| Build command | `npm install` |
| Start command | `npm start` |
| Health check path | `/api/health` |

Environment variables:

```env
NODE_ENV=production
MONGODB_URI=<atlas connection string>
JWT_SECRET=<new random string, 32+ characters>
JWT_EXPIRE=7d
CLIENT_URL=https://YOUR-APP.vercel.app        # exact origin, no trailing slash
MAX_PARTICIPANTS=100
LIVEKIT_URL=wss://YOUR-LIVEKIT-HOST           # what browsers connect to
LIVEKIT_API_URL=https://YOUR-LIVEKIT-HOST     # what the server calls
LIVEKIT_API_KEY=<your key>
LIVEKIT_API_SECRET=<your secret>
SFU_TOKEN_TTL_SECONDS=600
```

Do not set `PORT` (Render sets it). The server refuses to start in production if `JWT_SECRET` is shorter than 32 characters. Render's free tier sleeps when idle, so the first request can take 30 to 60 seconds.

## 4. Client on Vercel

| Setting | Value |
|---|---|
| Root directory | `client` |
| Build command | `npm run build` |
| Output directory | `dist` |

```env
VITE_API_URL=https://YOUR-SERVER.onrender.com/api
VITE_WS_URL=wss://YOUR-SERVER.onrender.com
```

`client/vercel.json` rewrites every path to `index.html`, so `/meeting/ABC234` links work. Camera and microphone only work on HTTPS (or localhost).

## 5. Connect them

After Vercel gives you the real URL, set `CLIENT_URL` on Render to it (exact, no trailing slash) and redeploy. A wrong `CLIENT_URL` shows up as CORS errors and a WebSocket that never connects.

## Final checks on the live URL

First open `https://YOUR-SERVER.onrender.com/api/health/media`. It must answer `{"success":true,"sfu":"reachable"}`. If not, the server cannot reach LiveKit (wrong `LIVEKIT_API_URL`, or the key and secret do not match).

Run the manual checklist in the README with two devices, ideally one on phone data and one on Wi-Fi. If the call connects on the same network but not across networks, you need TURN.
