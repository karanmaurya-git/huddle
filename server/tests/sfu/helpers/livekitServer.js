import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = process.env.LIVEKIT_SERVER_VERSION || '1.13.7';
const PLATFORMS = { 'linux-x64': 'linux_amd64', 'linux-arm64': 'linux_arm64', 'darwin-x64': 'darwin_amd64', 'darwin-arm64': 'darwin_arm64' };
export const SFU = { url: 'ws://127.0.0.1:7880', apiUrl: 'http://127.0.0.1:7880', apiKey: 'devkey', apiSecret: 'secret' };

async function isUp() {
  try {
    return (await fetch(SFU.apiUrl, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {
    return false;
  }
}

/** LIVEKIT_BIN, then a cached download, then a download from the GitHub releases page. */
async function findBinary() {
  if (process.env.LIVEKIT_BIN && fs.existsSync(process.env.LIVEKIT_BIN)) return process.env.LIVEKIT_BIN;
  const cacheDir = path.join(os.homedir(), '.cache', 'huddle');
  const cached = path.join(cacheDir, `livekit-server-${VERSION}`);
  if (fs.existsSync(cached)) return cached;

  const platform = PLATFORMS[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error(`no LiveKit server build for ${process.platform}-${process.arch}`);
  const url = `https://github.com/livekit/livekit/releases/download/v${VERSION}/livekit_${VERSION}_${platform}.tar.gz`;
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, `livekit-${VERSION}.tar.gz`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  execFileSync('tar', ['xzf', archive, '-C', cacheDir, 'livekit-server']);
  fs.renameSync(path.join(cacheDir, 'livekit-server'), cached);
  fs.rmSync(archive, { force: true });
  return cached;
}

/**
 * Starts a real `livekit-server --dev` for the tests. Resolves to { stop } or null when it
 * cannot run here (no binary, no network), so tests can skip with a clear message.
 */
export async function startLiveKit() {
  try {
    if (await isUp()) return { stop: async () => {}, external: true };
    const bin = await findBinary();
    const proc = spawn(bin, ['--dev', '--bind', '127.0.0.1'], { stdio: 'ignore' });
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    for (let i = 0; i < 60; i += 1) {
      if (await isUp()) {
        return {
          stop: async () => {
            proc.kill('SIGTERM');
            await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
          },
        };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    proc.kill('SIGKILL');
    throw new Error('livekit-server did not start in time');
  } catch (err) {
    console.warn(`[sfu tests] skipped: ${err.message}`);
    return null;
  }
}
