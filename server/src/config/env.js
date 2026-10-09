import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const stripSlash = (url) => (url || '').replace(/\/+$/, '');
const toInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 5000),
  mongoUri: process.env.MONGODB_URI,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpire: process.env.JWT_EXPIRE || '7d',
  clientUrl: stripSlash(process.env.CLIENT_URL || 'http://localhost:5173'),
  bcryptRounds: toInt(process.env.BCRYPT_ROUNDS, 10),
  authRateLimitMax: toInt(process.env.AUTH_RATE_LIMIT_MAX, 100),
  maxParticipants: toInt(process.env.MAX_PARTICIPANTS, 100),
  livekit: {
    url: process.env.LIVEKIT_URL || 'ws://127.0.0.1:7880', // what browsers connect to
    apiUrl: process.env.LIVEKIT_API_URL || 'http://127.0.0.1:7880', // what the server calls
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
    tokenTtlSeconds: toInt(process.env.SFU_TOKEN_TTL_SECONDS, 600),
  },
};

export const isProd = env.nodeEnv === 'production';

/** Origins allowed for CORS and for the WebSocket upgrade request. */
export function allowedOrigins() {
  const list = [env.clientUrl];
  if (!isProd) list.push('http://localhost:5173', 'http://127.0.0.1:5173');
  return list;
}

export function validateEnv() {
  const required = ['MONGODB_URI', 'JWT_SECRET', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (isProd && process.env.JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }
}
