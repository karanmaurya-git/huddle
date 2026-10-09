import { backoffDelay } from './backoff.js';

/**
 * What to do when the media (SFU) connection fully drops. The SDK retries short network blips
 * on its own; this decides about a FULL disconnect. A new connection needs a FRESH token, and
 * the server only issues one while we are still a member (the app WebSocket is connected).
 */
export function decideRecovery({ terminal, attempt, maxAttempts = 5, appConnected }) {
  if (terminal) return { action: 'stop' }; // we left, were removed, or the meeting ended
  if (attempt > maxAttempts) return { action: 'give-up' };
  if (!appConnected) return { action: 'wait-for-app' };
  return { action: 'retry-with-fresh-token', delayMs: backoffDelay(attempt) };
}
