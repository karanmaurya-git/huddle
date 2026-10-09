import { RateLimiter } from '../utils/rateLimiter.js';
import { sendRaw, encode } from './protocol.js';

export class Participant {
  constructor({ userId, username, role, ws }) {
    this.userId = userId;
    this.username = username;
    this.role = role;
    this.ws = ws;
    this.joinedAt = Date.now();
    this.handRaisedAt = null; // timestamp while the hand is up, else null (also the queue order)
    this.graceTimer = null;
    // Per-user limits live here so they disappear with the participant.
    this.limits = {
      chat: new RateLimiter(5, 5000),
      action: new RateLimiter(10, 5000),
    };
  }

  get connected() {
    return Boolean(this.ws) && this.ws.readyState === 1;
  }

  attach(ws) {
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.ws = ws;
  }

  detach() {
    this.ws = null;
  }

  send(type, payload) {
    sendRaw(this.ws, encode(type, payload));
  }

  sendRaw(data) {
    sendRaw(this.ws, data);
  }

  close(code, reason) {
    this.ws?.close(code, reason);
  }

  toPublic() {
    return {
      userId: this.userId,
      username: this.username,
      role: this.role,
      handRaised: this.handRaisedAt !== null,
      handRaisedAt: this.handRaisedAt,
      joinedAt: this.joinedAt,
    };
  }
}
