import { Room } from './Room.js';
import { DEFAULT_OPTIONS } from './constants.js';
import * as meetingService from '../services/meetingService.js';

/** Owns all active (in-memory) rooms and loads/unloads them from MongoDB. */
export class RoomManager {
  constructor({ options = {}, persistence = meetingService, sfu = null, maxParticipants = 100 } = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.persistence = persistence;
    this.sfu = sfu;
    this.defaultMax = maxParticipants;
    this.rooms = new Map();
    this.loading = new Map(); // code -> Promise, so two joins do not load the same room twice
  }

  createRoom({ roomId, hostId, maxParticipants, locked = false }) {
    const room = new Room({
      roomId,
      hostId,
      maxParticipants: Math.min(maxParticipants ?? this.defaultMax, this.defaultMax),
      locked,
      options: this.options,
      hooks: {
        onEmpty: (r) => this.scheduleEviction(r),
        onHostChange: (r) => this.#persist('host', () => this.persistence.saveHost(r.roomId, r.hostId)),
        onLockChange: (r) => this.#persist('lock', () => this.persistence.saveLocked(r.roomId, r.locked)),
        onPresenterReleased: (r, userId) => this.#revokeShare(r.roomId, userId),
      },
    });
    this.rooms.set(roomId, room);
    this.scheduleEviction(room); // evicted again if nobody joins
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  /** Memory first; otherwise rehydrate from MongoDB. Returns { room } or { error }. */
  async getOrLoadRoom(roomId) {
    const active = this.rooms.get(roomId);
    if (active) return { room: active };
    if (this.loading.has(roomId)) return this.loading.get(roomId);

    const loadPromise = (async () => {
      const record = await this.persistence.findMeeting(roomId);
      if (!record) return { error: 'ROOM_NOT_FOUND' };
      if (record.status === 'ended') return { error: 'MEETING_ENDED' };
      const existing = this.rooms.get(roomId); // another path may have created it meanwhile
      if (existing) return { room: existing };
      return {
        room: this.createRoom({
          roomId,
          hostId: record.hostId,
          maxParticipants: record.maxParticipants,
          locked: record.locked,
        }),
      };
    })().finally(() => this.loading.delete(roomId));

    this.loading.set(roomId, loadPromise);
    return loadPromise;
  }

  /** Removes a room for good (ended or deleted) and disconnects everyone inside. */
  closeRoom(roomId, message) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    this.rooms.delete(roomId);
    room.close(message);
    return true;
  }

  scheduleEviction(room) {
    clearTimeout(room.evictTimer);
    room.evictTimer = setTimeout(() => this.evict(room), this.options.emptyRoomMs);
    room.evictTimer.unref?.();
  }

  cancelEviction(room) {
    clearTimeout(room.evictTimer);
    room.evictTimer = null;
  }

  /** Frees memory for an empty room. The MongoDB record stays so the link keeps working. */
  async evict(room) {
    if (room.participants.size > 0 || this.rooms.get(room.roomId) !== room) return;
    this.rooms.delete(room.roomId);
    room.destroy();
    await this.#persist('unload', () => this.persistence.touchMeeting(room.roomId));
  }

  shutdown() {
    for (const room of this.rooms.values()) room.destroy();
    this.rooms.clear();
  }

  async #persist(what, fn) {
    try {
      await fn();
    } catch (err) {
      console.error(`Failed to save ${what}`, err.message);
    }
  }

  /** When the presenter slot is freed, take the screen-share permission away on the SFU. */
  #revokeShare(roomId, userId) {
    if (!this.sfu) return;
    this.sfu.stopScreenShare(roomId, userId).catch(() => {
      /* the participant may already be gone from the SFU, nothing left to revoke */
    });
  }
}
