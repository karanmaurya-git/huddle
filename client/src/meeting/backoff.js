// Close codes the server uses to say "do not reconnect".
const NO_RECONNECT = new Set([1000, 4001, 4002, 4004, 4005]);

export const shouldReconnect = (code) => !NO_RECONNECT.has(code);

/** 1s, 2s, 4s, 8s... capped at maxMs. */
export const backoffDelay = (attempt, baseMs = 1000, maxMs = 10000) => Math.min(baseMs * 2 ** Math.max(0, attempt - 1), maxMs);
