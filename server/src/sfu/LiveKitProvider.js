import { AccessToken, RoomServiceClient, TrackSource, WebhookReceiver } from 'livekit-server-sdk';
import { SfuProvider } from './SfuProvider.js';

const BASE_SOURCES = [TrackSource.CAMERA, TrackSource.MICROPHONE];
const SHARE_SOURCES = [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];

/**
 * What a client token is allowed to do. Pure function so it can be unit tested.
 * - Chat uses our own WebSocket, so nobody can publish data packets.
 * - Screen share is NOT allowed by default: the server adds it only to the one presenter.
 * - Admin permissions (roomAdmin, roomCreate...) are never given to a browser.
 */
export function permissionFor({ canShare = false } = {}) {
  return {
    canSubscribe: true,
    canPublish: true,
    canPublishData: false,
    canPublishSources: canShare ? [...BASE_SOURCES, ...SHARE_SOURCES] : [...BASE_SOURCES],
    hidden: false,
  };
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Classifies a failed call to LiveKit. Shapes were captured from the real SDK:
 *  - server not running      -> TypeError "fetch failed" with cause ECONNREFUSED
 *  - wrong host name         -> TypeError "fetch failed" with cause ENOTFOUND
 *  - wrong API key / secret  -> error named "Unauthorized" with status 401
 */
export function describeSfuError(err, apiUrl = '') {
  const code = err?.cause?.code || err?.code;
  if (NETWORK_CODES.has(code) || err?.message === 'fetch failed') {
    return {
      reason: 'unreachable',
      hint: `Cannot reach the LiveKit media server at ${apiUrl}. Start it (for example: livekit-server --dev) and check LIVEKIT_API_URL in server/.env.`,
    };
  }
  if (err?.status === 401 || err?.status === 403 || err?.name === 'Unauthorized') {
    return {
      reason: 'bad_credentials',
      hint: 'LiveKit rejected the API key or secret. LIVEKIT_API_KEY and LIVEKIT_API_SECRET in server/.env must match the keys LiveKit was started with (livekit-server --dev uses devkey and secret).',
    };
  }
  return { reason: 'other', hint: `LiveKit returned an error: ${err?.message || 'unknown error'}` };
}

const sourceName = (source) => (typeof source === 'number' ? TrackSource[source] : source);

export class LiveKitProvider extends SfuProvider {
  constructor({ url, apiUrl, apiKey, apiSecret, tokenTtlSeconds = 600 }) {
    super();
    this.url = url;
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.tokenTtlSeconds = tokenTtlSeconds;
    this.rooms = new RoomServiceClient(apiUrl, apiKey, apiSecret);
    this.webhooks = new WebhookReceiver(apiKey, apiSecret);
  }

  get publicUrl() {
    return this.url;
  }

  async createToken({ userId, username, role, roomCode, canShare = false }) {
    const token = new AccessToken(this.apiKey, this.apiSecret, {
      identity: String(userId),
      name: username,
      ttl: this.tokenTtlSeconds, // only needed to connect, so keep it short
      metadata: JSON.stringify({ role }), // set by the server only
    });
    const permission = permissionFor({ canShare });
    token.addGrant({
      roomJoin: true,
      room: roomCode,
      canSubscribe: permission.canSubscribe,
      canPublish: permission.canPublish,
      canPublishData: permission.canPublishData,
      canPublishSources: permission.canPublishSources,
    });
    return token.toJwt();
  }

  async ensureRoom(roomCode, { maxParticipants } = {}) {
    // CreateRoom is idempotent in LiveKit: an existing room is returned unchanged.
    await this.rooms.createRoom({
      name: roomCode,
      maxParticipants,
      emptyTimeout: 5 * 60,
      departureTimeout: 2 * 60,
    });
  }

  async #publishedTracks(roomCode, userId, sources) {
    const info = await this.rooms.getParticipant(roomCode, String(userId));
    return (info.tracks || []).filter((t) => sources.includes(t.source));
  }

  async muteMicrophone(roomCode, userId) {
    const tracks = await this.#publishedTracks(roomCode, userId, [TrackSource.MICROPHONE]);
    await Promise.all(tracks.map((t) => this.rooms.mutePublishedTrack(roomCode, String(userId), t.sid, true)));
  }

  removeParticipant(roomCode, userId) {
    return this.rooms.removeParticipant(roomCode, String(userId));
  }

  deleteRoom(roomCode) {
    return this.rooms.deleteRoom(roomCode);
  }

  async setScreenSharePermission(roomCode, userId, allowed) {
    await this.rooms.updateParticipant(roomCode, String(userId), {
      permission: permissionFor({ canShare: allowed }),
    });
  }

  /** Revoke the permission and mute any screen-share track that is still being published. */
  async stopScreenShare(roomCode, userId) {
    await this.setScreenSharePermission(roomCode, userId, false);
    const tracks = await this.#publishedTracks(roomCode, userId, SHARE_SOURCES);
    await Promise.all(tracks.map((t) => this.rooms.mutePublishedTrack(roomCode, String(userId), t.sid, true)));
  }

  async updateRole(roomCode, userId, role) {
    await this.rooms.updateParticipant(roomCode, String(userId), { metadata: JSON.stringify({ role }) });
  }

  async healthCheck() {
    try {
      await this.rooms.listRooms();
      return { ok: true };
    } catch (err) {
      return { ok: false, ...describeSfuError(err, this.apiUrl) };
    }
  }

  describeError(err) {
    return describeSfuError(err, this.apiUrl);
  }

  async receiveWebhook(rawBody, authHeader) {
    const event = await this.webhooks.receive(rawBody, authHeader); // throws on a bad signature
    return {
      type: event.event,
      room: event.room?.name,
      identity: event.participant?.identity,
      trackSource: event.track ? sourceName(event.track.source) : undefined,
    };
  }
}
