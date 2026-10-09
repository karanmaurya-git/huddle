import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { allowedOrigins, env, isProd } from './config/env.js';
import { AppError } from './utils/errors.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { createAuthController } from './controllers/authController.js';
import { createMeetingController } from './controllers/meetingController.js';
import { createSfuController } from './controllers/sfuController.js';
import { createAuthRoutes } from './routes/authRoutes.js';
import { createMeetingRoutes } from './routes/meetingRoutes.js';

/** Builds the Express app. Kept separate from index.js so tests can use it without listening. */
export function createApp({ roomManager, ticketService, sfu, lifecycle }) {
  const app = express();
  app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        // No Origin header = non-browser client (curl, health checks, the SFU webhook).
        if (!origin || allowedOrigins().includes(origin)) return callback(null, true);
        return callback(new AppError('Origin not allowed', 403));
      },
    })
  );

  const sfuController = createSfuController({ roomManager, sfu });
  // The webhook must be mounted BEFORE express.json(): signature checks need the raw body.
  app.post('/api/sfu/webhook', express.raw({ type: () => true, limit: '1mb' }), sfuController.webhook);

  app.use(express.json({ limit: '10kb' }));

  app.get('/', (_req, res) => res.json({ success: true, message: 'Huddle API' }));
  app.get('/api/health', (_req, res) => res.json({ success: true, message: 'Server is running' }));

  // Is the media server (LiveKit) reachable with our credentials? Handy when audio and video fail.
  app.get('/api/health/media', async (_req, res) => {
    const result = await sfu.healthCheck();
    if (result.ok) return res.json({ success: true, sfu: 'reachable' });
    return res.status(503).json({
      success: false,
      sfu: 'unreachable',
      reason: result.reason,
      ...(isProd ? {} : { hint: result.hint }),
    });
  });

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.authRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later' },
  });

  // A looser limit for the rest of the API, so creating meetings cannot be spammed.
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.nodeEnv === 'test' ? 100_000 : 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later' },
  });

  app.use('/api/auth', authLimiter, createAuthRoutes(createAuthController({ ticketService, roomManager })));
  app.use('/api/meetings', apiLimiter, createMeetingRoutes(createMeetingController({ roomManager, lifecycle }), sfuController));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
