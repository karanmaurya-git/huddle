// Creates server/.env and client/.env from the .env.example files, with a fresh random
// JWT_SECRET, so no secret ever has to be committed or shipped. Safe to run again: it never
// overwrites an existing .env file.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const created = [];

for (const dir of ['server', 'client']) {
  const example = join(root, dir, '.env.example');
  const target = join(root, dir, '.env');
  if (existsSync(target)) {
    console.log(`${dir}/.env already exists, left unchanged`);
    continue;
  }
  copyFileSync(example, target);
  if (dir === 'server') {
    const secret = randomBytes(48).toString('hex');
    writeFileSync(target, readFileSync(target, 'utf8').replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${secret}`));
  }
  created.push(`${dir}/.env`);
}

console.log(created.length ? `Created ${created.join(' and ')}.` : 'Nothing to do.');
console.log('Next: set MONGODB_URI in server/.env if you are not using a local MongoDB, then start the SFU, the server and the client (see README).');
