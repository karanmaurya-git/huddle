import { isProd } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { normalizeRoomCode } from '../utils/roomCode.js';
import { handleSfuEvent } from '../websocket/sfuEvents.js';

export function createSfuController({ roomManager, sfu }) {
  return {
    /**
     * The app server is the gatekeeper for media. A token is only issued to someone who is
     * CURRENTLY a member of the in-memory room, so lock, capacity and removal rules cannot be
     * bypassed by calling this endpoint directly.
     */
    async token(req, res) {
      const code = normalizeRoomCode(req.params.code);
      if (!code) throw new AppError('Invalid meeting code', 400);

      const room = roomManager.getRoom(code);
      const member = room && !room.closed && !room.isKicked(req.user.id) ? room.getParticipant(req.user.id) : null;
      if (!member) throw new AppError('Join the meeting before requesting media access', 403);

      try {
        await sfu.ensureRoom(code, { maxParticipants: room.maxParticipants });
        const token = await sfu.createToken({
          userId: req.user.id,
          username: req.user.name,
          role: member.role,
          roomCode: code,
          canShare: room.presenterId === req.user.id, // keep the grant if they reconnect while presenting
        });
        res.json({ success: true, token, url: sfu.publicUrl });
      } catch (err) {
        const { reason, hint } = sfu.describeError(err);
        console.error(`SFU token failed (${reason}): ${hint}`);
        // Developers get the actionable hint; in production users only see a generic message.
        throw new AppError(isProd ? 'The media server is unavailable right now' : hint, 503, 'SFU_UNAVAILABLE');
      }
    },

    /** LiveKit webhook. Needs the RAW body to verify the signature. */
    async webhook(req, res) {
      let event;
      try {
        event = await sfu.receiveWebhook(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '', req.get('Authorization'));
      } catch {
        throw new AppError('Invalid webhook signature', 401);
      }
      handleSfuEvent({ roomManager }, event);
      res.json({ success: true });
    },
  };
}
