// Runs N headless bots through the REAL app flow (REST, WebSocket, SFU token, real SFU media).
// N comes from LOAD_USERS (default 12). Prints a report with the numbers that were observed.
import { describe, it, expect, afterAll } from 'vitest';
import { LiveKitProvider } from '../../src/sfu/LiveKitProvider.js';
import { startTestServer } from '../helpers/testServer.js';
import { runLoad } from '../../scripts/lib/loadBot.mjs';
import { startLiveKit, SFU } from './helpers/livekitServer.js';

const lk = await startLiveKit();
afterAll(async () => lk?.stop());

describe.skipIf(!lk)('load: many bots through the real join flow', () => {
  it('connects every bot, and every listener receives audio through the SFU', async () => {
    const users = Number(process.env.LOAD_USERS || 12);
    const sfu = new LiveKitProvider({ url: SFU.url, apiUrl: SFU.apiUrl, apiKey: SFU.apiKey, apiSecret: SFU.apiSecret });
    const srv = await startTestServer({ sfu, maxParticipants: Math.max(100, users) });
    try {
      const report = await runLoad({ apiUrl: `${srv.baseUrl}/api`, wsUrl: srv.wsUrl, users, publishers: 3, holdMs: 4000, concurrency: 4, log: () => {} });
      console.log(`LOAD REPORT ${JSON.stringify(report)}`);
      expect(report.failed).toBe(0);
      expect(report.connected).toBe(users);
      expect(report.listenersReceivingAudio).toBe(report.listeners);
      expect(report.maxRemotesSeenByOneBot).toBe(users - 1);
    } finally {
      await srv.close();
    }
  });
});
