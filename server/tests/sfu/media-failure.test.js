// The exact situation from a real bug report: the app works, but LiveKit is not running, so
// every media connection failed. This test reproduces it with the REAL provider and then
// starts a real LiveKit and checks that the same meeting recovers without being recreated.
import { describe, it, expect, afterAll } from 'vitest';
import { LiveKitProvider } from '../../src/sfu/LiveKitProvider.js';
import { startTestServer, registerUser, createMeeting, joinAs, api, sleep } from '../helpers/testServer.js';
import { connectMediaWithToken } from './helpers/bots.js';
import { startLiveKit, SFU } from './helpers/livekitServer.js';

let lk = null;
afterAll(async () => lk?.stop());

describe('media server down, then up', () => {
  it('keeps the app working, explains the problem, and recovers once LiveKit starts', async (ctx) => {
    const sfu = new LiveKitProvider({ url: SFU.url, apiUrl: SFU.apiUrl, apiKey: SFU.apiKey, apiSecret: SFU.apiSecret });
    const srv = await startTestServer({ sfu });
    try {
      const host = await registerUser(srv.baseUrl, 'Host');
      const code = await createMeeting(srv.baseUrl, host.token);
      const a = await joinAs(srv, 'Host', code, host.token);

      // 1. LiveKit is not running yet: the token request fails with a clear, actionable message.
      const down = await api(srv.baseUrl, `/meetings/${code}/sfu-token`, { method: 'POST', token: host.token });
      expect(down.status).toBe(503);
      expect(down.body.code).toBe('SFU_UNAVAILABLE');
      expect(down.body.message).toMatch(/Cannot reach the LiveKit media server/);
      expect(down.body.message).toContain('livekit-server --dev');
      const health = await fetch(`${srv.baseUrl}/api/health/media`);
      expect(health.status).toBe(503);
      expect((await health.json()).reason).toBe('unreachable');

      // 2. Everything that does not need media still works (presence, chat).
      a.client.send('chat_message', { message: 'media is down but chat works' });
      expect((await a.client.waitFor('chat_message')).message).toContain('chat works');

      // 3. Start LiveKit. The same meeting recovers: no need to recreate or rejoin it.
      lk = await startLiveKit();
      if (!lk) return ctx.skip();
      for (let i = 0; i < 20 && (await fetch(`${srv.baseUrl}/api/health/media`)).status !== 200; i += 1) await sleep(250);
      const up = await api(srv.baseUrl, `/meetings/${code}/sfu-token`, { method: 'POST', token: host.token });
      expect(up.status).toBe(200);

      // 4. And the token really connects to the media server.
      const room = await connectMediaWithToken({ createToken: async () => up.body.token, publicUrl: up.body.url }, code, 'unused');
      expect(room.localParticipant.identity).toBe(host.user.id);
      await room.disconnect();
      return undefined;
    } finally {
      await srv.close();
    }
  });
});
