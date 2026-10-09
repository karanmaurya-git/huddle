import { randomBytes } from 'node:crypto';

export const TICKET_TTL_MS = 30_000;

/**
 * Short-lived, single-use WebSocket tickets.
 * Browsers cannot set an Authorization header on `new WebSocket()`, and a long-lived JWT in
 * the URL would leak into logs. A 30-second one-shot ticket bound to one user and one
 * meeting is safe to put in the URL, and it is deleted the moment it is used.
 */
export class TicketService {
  constructor(ttlMs = TICKET_TTL_MS) {
    this.ttlMs = ttlMs;
    this.tickets = new Map();
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  issue({ userId, username, roomId }) {
    const ticket = randomBytes(24).toString('hex');
    this.tickets.set(ticket, { userId, username, roomId, expiresAt: Date.now() + this.ttlMs });
    return ticket;
  }

  /** Returns the session bound to the ticket and deletes it. Null if unknown, used or expired. */
  consume(ticket) {
    if (typeof ticket !== 'string') return null;
    const session = this.tickets.get(ticket);
    if (!session) return null;
    this.tickets.delete(ticket); // single use, even when expired
    return session.expiresAt >= Date.now() ? session : null;
  }

  cleanup() {
    const now = Date.now();
    for (const [ticket, session] of this.tickets) {
      if (session.expiresAt < now) this.tickets.delete(ticket);
    }
  }

  close() {
    clearInterval(this.cleanupTimer);
  }
}
