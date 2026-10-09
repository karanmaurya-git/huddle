import { LiveKitProvider } from '../../src/sfu/LiveKitProvider.js';

/**
 * Test double for the media server. It inherits the REAL token signing (so grants can be
 * inspected) and replaces only the network calls with a recorder. Used in tests only.
 */
export class FakeSfu extends LiveKitProvider {
  constructor() {
    super({ url: 'ws://sfu.test', apiUrl: 'http://sfu.test', apiKey: 'devkey', apiSecret: 'secret-secret-secret-secret-secret' });
    this.calls = [];
    this.failing = new Set(); // method names that should throw
    this.errors = new Map(); // optional custom error to throw for a method
    this.healthResult = { ok: true };
  }

  #record(name, ...args) {
    this.calls.push({ name, args });
    if (this.failing.has(name)) throw this.errors.get(name) ?? new Error(`${name} failed (test)`);
  }

  callsOf(name) {
    return this.calls.filter((c) => c.name === name);
  }

  async ensureRoom(...a) { this.#record('ensureRoom', ...a); }
  async muteMicrophone(...a) { this.#record('muteMicrophone', ...a); }
  async removeParticipant(...a) { this.#record('removeParticipant', ...a); }
  async deleteRoom(...a) { this.#record('deleteRoom', ...a); }
  async setScreenSharePermission(...a) { this.#record('setScreenSharePermission', ...a); }
  async stopScreenShare(...a) { this.#record('stopScreenShare', ...a); }
  async updateRole(...a) { this.#record('updateRole', ...a); }
  async healthCheck() { return this.healthResult; }

  /** "Valid" webhooks carry the header `Authorization: valid`; the body is the JSON event. */
  async receiveWebhook(rawBody, authHeader) {
    if (authHeader !== 'valid') throw new Error('bad signature');
    const e = JSON.parse(rawBody);
    return { type: e.type, room: e.room, identity: e.identity, trackSource: e.trackSource };
  }
}
