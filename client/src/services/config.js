const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
// No path: the ws server is attached directly to the HTTP server.
export const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:5000';

export const PLAN_CONFIG = {
  pageSize: num(import.meta.env.VITE_VIDEO_PAGE_SIZE, 12),
  audioAllLimit: num(import.meta.env.VITE_AUDIO_SUBSCRIBE_ALL_LIMIT, 25),
  audioTopN: num(import.meta.env.VITE_AUDIO_TOP_N, 10),
};
