import { env } from '../config/env.js';
import { LiveKitProvider } from './LiveKitProvider.js';

export function createSfuProvider() {
  return new LiveKitProvider({
    url: env.livekit.url,
    apiUrl: env.livekit.apiUrl,
    apiKey: env.livekit.apiKey,
    apiSecret: env.livekit.apiSecret,
    tokenTtlSeconds: env.livekit.tokenTtlSeconds,
  });
}

export { SfuProvider } from './SfuProvider.js';
export { LiveKitProvider, permissionFor, describeSfuError } from './LiveKitProvider.js';
