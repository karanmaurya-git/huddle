/**
 * The only thing the rest of the server knows about the SFU (the media server).
 * Everything media-related goes through this interface, so LiveKit could be replaced by
 * another SFU (mediasoup, Janus...) by writing one new class.
 *
 * The SFU never decides who is allowed in. The app server checks membership, capacity, lock
 * and bans first, and only then asks the SFU for a token or to act on a participant.
 */
export class SfuProvider {
  /** WebSocket URL browsers should connect to. */
  get publicUrl() {
    throw new Error('not implemented');
  }

  /** Token a browser uses to connect. `identity` is always the app userId. */
  async createToken(_params) {
    throw new Error('not implemented');
  }

  async ensureRoom(_roomCode, _options) {
    throw new Error('not implemented');
  }

  async muteMicrophone(_roomCode, _userId) {
    throw new Error('not implemented');
  }

  async removeParticipant(_roomCode, _userId) {
    throw new Error('not implemented');
  }

  async deleteRoom(_roomCode) {
    throw new Error('not implemented');
  }

  async setScreenSharePermission(_roomCode, _userId, _allowed) {
    throw new Error('not implemented');
  }

  async stopScreenShare(_roomCode, _userId) {
    throw new Error('not implemented');
  }

  async updateRole(_roomCode, _userId, _role) {
    throw new Error('not implemented');
  }

  /** Is the media server reachable with our credentials? Resolves { ok } or { ok:false, reason, hint }. */
  async healthCheck() {
    throw new Error('not implemented');
  }

  /** Turns an error from any call above into { reason, hint } a developer can act on. */
  describeError(_err) {
    return { reason: 'other', hint: 'The media server returned an error.' };
  }

  /** Verifies a webhook and returns { type, room, identity, trackSource } (or throws). */
  async receiveWebhook(_rawBody, _authHeader) {
    throw new Error('not implemented');
  }
}
