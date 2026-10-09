import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { generateRoomCode, normalizeRoomCode } from '../utils/roomCode.js';
import {
  createMeeting,
  findMeeting,
  listRecentForUser,
  recordMembership,
} from '../services/meetingService.js';

export function createMeetingController({ roomManager, lifecycle }) {
  return {
    async create(req, res) {
      const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      if (title.length > 80) throw new AppError('Title must be 80 characters or fewer', 400);

      // Retry on the (very unlikely) collision with an existing code.
      let code;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const candidate = generateRoomCode();
        if (!roomManager.getRoom(candidate) && !(await findMeeting(candidate))) {
          code = candidate;
          break;
        }
      }
      if (!code) throw new AppError('Could not generate a meeting code, try again', 500);

      const meeting = await createMeeting({
        code,
        hostId: req.user.id,
        title,
        maxParticipants: env.maxParticipants,
      });
      roomManager.createRoom({ roomId: code, hostId: meeting.hostId, maxParticipants: meeting.maxParticipants });
      await recordMembership(req.user.id, code);
      res.status(201).json({ success: true, meeting: { code, title, status: 'active', locked: false } });
    },

    async get(req, res) {
      const code = normalizeRoomCode(req.params.code);
      if (!code) throw new AppError('Invalid meeting code', 400);

      const active = roomManager.getRoom(code);
      const record = await findMeeting(code);
      if (!record) throw new AppError('Meeting not found', 404);

      res.json({
        success: true,
        meeting: {
          code,
          title: record.title,
          status: record.status,
          locked: active ? active.locked : record.locked,
          count: active ? active.count : 0,
          capacity: active ? active.maxParticipants : Math.min(record.maxParticipants, env.maxParticipants),
          isHost: (active ? active.hostId : record.hostId) === req.user.id,
        },
      });
    },

    async list(req, res) {
      const meetings = await listRecentForUser(req.user.id);
      res.json({
        success: true,
        meetings: meetings.map((m) => ({
          code: m.code,
          title: m.title,
          status: m.status,
          locked: roomManager.getRoom(m.code)?.locked ?? m.locked,
          isHost: roomManager.getRoom(m.code) ? roomManager.getRoom(m.code).hostId === req.user.id : m.isHost,
          live: roomManager.getRoom(m.code)?.count ?? 0,
          lastJoinedAt: m.lastJoinedAt,
        })),
      });
    },

    // Only the CURRENT host may delete. Everyone inside is told and disconnected.
    async remove(req, res) {
      const code = normalizeRoomCode(req.params.code);
      if (!code) throw new AppError('Invalid meeting code', 400);

      const active = roomManager.getRoom(code);
      const record = active ? null : await findMeeting(code);
      if (!active && !record) throw new AppError('Meeting not found', 404);

      const hostId = active ? active.hostId : record.hostId;
      if (hostId !== req.user.id) throw new AppError('Only the host can delete this meeting', 403);

      await lifecycle.endMeeting(code, { remove: true, message: 'The host deleted this meeting.' });
      res.json({ success: true, message: 'Meeting deleted' });
    },
  };
}
