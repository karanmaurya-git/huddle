import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    exclude: ['tests/sfu/**', 'node_modules/**'],
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-test-secret',
      BCRYPT_ROUNDS: '4',
      CLIENT_URL: 'http://localhost:5173',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret-secret-secret-secret-secret',
      MAX_PARTICIPANTS: '100',
      AUTH_RATE_LIMIT_MAX: '100000',
    },
    testTimeout: 15000,
  },
});
