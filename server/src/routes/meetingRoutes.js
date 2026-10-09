import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

export function createMeetingRoutes(meetings, sfuController) {
  const router = Router();
  router.use(requireAuth);
  router.get('/', meetings.list);
  router.post('/', meetings.create);
  router.get('/:code', meetings.get);
  router.post('/:code/sfu-token', sfuController.token);
  router.delete('/:code', meetings.remove);
  return router;
}
