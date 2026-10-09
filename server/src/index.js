import http from 'node:http';
import { env, validateEnv } from './config/env.js';
import { connectDB, disconnectDB } from './config/db.js';
import { createApp } from './app.js';
import { createSfuProvider } from './sfu/index.js';
import { TicketService } from './services/ticketService.js';
import { createMeetingLifecycle } from './services/meetingLifecycle.js';
import * as meetingService from './services/meetingService.js';
import { RoomManager } from './websocket/RoomManager.js';
import { setupWebSocket } from './websocket/index.js';

validateEnv();
await connectDB(env.mongoUri);

const sfu = createSfuProvider();
const ticketService = new TicketService();
const roomManager = new RoomManager({ sfu, maxParticipants: env.maxParticipants });
const lifecycle = createMeetingLifecycle({ roomManager, sfu });

const server = http.createServer(createApp({ roomManager, ticketService, sfu, lifecycle }));
const wss = setupWebSocket({ server, roomManager, ticketService, sfu, lifecycle, persistence: meetingService });

server.listen(env.port, () => console.log(`Server listening on port ${env.port} (${env.nodeEnv})`));

// Tell the developer right away if audio and video cannot work, instead of failing later in the browser.
sfu.healthCheck().then((result) => {
  if (result.ok) console.log(`Media server (LiveKit) reachable at ${env.livekit.apiUrl}`);
  else console.warn(`WARNING: media server not ready (${result.reason}). ${result.hint}\nMeetings still work, but audio and video will not connect until this is fixed.`);
});

async function shutdown() {
  console.log('Shutting down...');
  wss.close();
  roomManager.shutdown();
  ticketService.close();
  server.close(async () => {
    await disconnectDB();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));
