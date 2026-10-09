import { Room } from '@livekit/rtc-node';
import { publishTone, countIncomingAudio, sleep } from '../../../scripts/lib/loadBot.mjs';

export { publishTone, countIncomingAudio, sleep };

/** Connects a headless participant using a token minted by the provider under test. */
export async function connectMediaWithToken(sfu, code, userId, { username = userId, role = 'participant' } = {}) {
  const token = await sfu.createToken({ userId, username, role, roomCode: code });
  const room = new Room();
  await room.connect(sfu.publicUrl, token, { autoSubscribe: true, dynacast: false });
  return room;
}
