import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { signToken } from '../utils/token.js';
import { normalizeRoomCode } from '../utils/roomCode.js';
import { createUser, findUserByEmail, toPublicUser } from '../services/userService.js';
import { findMeeting } from '../services/meetingService.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAuthController({ ticketService, roomManager }) {
  return {
    async register(req, res) {
      const { name, email, password } = req.body || {};
      if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 50) {
        throw new AppError('Name must be 2-50 characters', 400);
      }
      if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
        throw new AppError('A valid email is required', 400);
      }
      if (typeof password !== 'string' || password.length < 8 || password.length > 100) {
        throw new AppError('Password must be 8-100 characters', 400);
      }

      const normalizedEmail = email.trim().toLowerCase();
      if (await findUserByEmail(normalizedEmail)) throw new AppError('Email is already registered', 409);

      const passwordHash = await bcrypt.hash(password, env.bcryptRounds);
      const user = await createUser({ name: name.trim(), email: normalizedEmail, passwordHash });
      res.status(201).json({ success: true, token: signToken(user._id), user: toPublicUser(user) });
    },

    async login(req, res) {
      const { email, password } = req.body || {};
      if (typeof email !== 'string' || typeof password !== 'string') {
        throw new AppError('Email and password are required', 400);
      }
      const user = await findUserByEmail(email.trim().toLowerCase());
      // Same message for an unknown email and a wrong password so emails cannot be probed.
      const valid = user && (await bcrypt.compare(password, user.passwordHash));
      if (!valid) throw new AppError('Invalid email or password', 401);

      res.json({ success: true, token: signToken(user._id), user: toPublicUser(user) });
    },

    // JWTs are stateless: logging out means the client discards its token.
    logout(_req, res) {
      res.json({ success: true, message: 'Logged out' });
    },

    async createWsTicket(req, res) {
      const roomId = normalizeRoomCode(req.body?.roomId);
      if (!roomId) throw new AppError('A valid roomId is required', 400);

      const active = roomManager.getRoom(roomId);
      if (!active) {
        const record = await findMeeting(roomId);
        if (!record) throw new AppError('Meeting not found', 404);
        if (record.status === 'ended') throw new AppError('This meeting has ended', 410);
      }
      if (active?.isKicked(req.user.id)) throw new AppError('You were removed from this meeting', 403);

      const ticket = ticketService.issue({ userId: req.user.id, username: req.user.name, roomId });
      res.json({ success: true, ticket, expiresIn: Math.round(ticketService.ttlMs / 1000) });
    },
  };
}
