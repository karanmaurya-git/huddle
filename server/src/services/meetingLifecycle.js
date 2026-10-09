import * as meetingService from './meetingService.js';

/**
 * Ending or deleting a meeting touches three places (memory, the SFU, MongoDB), so it lives
 * in one function used by both the WebSocket `end_meeting` event and REST `DELETE`.
 */
export function createMeetingLifecycle({ roomManager, sfu, persistence = meetingService }) {
  return {
    async endMeeting(code, { remove = false, message = 'The host ended the meeting.' } = {}) {
      roomManager.closeRoom(code, message); // tells everyone and closes their sockets (4005)
      try {
        await sfu.deleteRoom(code); // disconnects everyone's media
      } catch (err) {
        console.error('SFU deleteRoom failed:', err.message); // the SFU also times empty rooms out
      }
      if (remove) await persistence.deleteMeeting(code);
      else await persistence.markEnded(code);
    },
  };
}
