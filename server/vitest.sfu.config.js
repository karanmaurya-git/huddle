import { defineConfig } from 'vitest/config';

// Integration tests against a REAL livekit-server and real media. They skip themselves
// (with a message) when the binary cannot be found or downloaded.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/sfu/**/*.test.js'],
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'test-secret-test-secret',
      BCRYPT_ROUNDS: '4',
      CLIENT_URL: 'http://localhost:5173',
      AUTH_RATE_LIMIT_MAX: '100000',
    },
    testTimeout: 90000,
    hookTimeout: 90000,
    fileParallelism: false,
  },
});
