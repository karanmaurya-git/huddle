import Meeting from '../models/Meeting.js';
import MeetingMembership from '../models/MeetingMembership.js';

const toPlain = (doc) =>
  doc && {
    code: doc.code,
    hostId: String(doc.hostId),
    title: doc.title || '',
    status: doc.status,
    locked: Boolean(doc.locked),
    maxParticipants: doc.maxParticipants,
    createdAt: doc.createdAt,
    endedAt: doc.endedAt || null,
  };

export async function findMeeting(code) {
  return toPlain(await Meeting.findOne({ code }));
}

export async function createMeeting({ code, hostId, title, maxParticipants }) {
  return toPlain(await Meeting.create({ code, hostId, title, maxParticipants }));
}

// MongoDB is only written on: create, host change, lock change, end/delete, unload, and join
// (for "recent meetings"). Never on chat, hands, mute or media events.
export const saveHost = (code, hostId) =>
  Meeting.updateOne({ code }, { $set: { hostId, lastActiveAt: new Date() } });

export const saveLocked = (code, locked) =>
  Meeting.updateOne({ code }, { $set: { locked, lastActiveAt: new Date() } });

export const touchMeeting = (code) => Meeting.updateOne({ code }, { $set: { lastActiveAt: new Date() } });

export const markEnded = (code) =>
  Meeting.updateOne({ code }, { $set: { status: 'ended', endedAt: new Date(), lastActiveAt: new Date() } });

export async function deleteMeeting(code) {
  await Meeting.deleteOne({ code });
  await MeetingMembership.deleteMany({ meetingCode: code });
}

export const recordMembership = (userId, meetingCode) =>
  MeetingMembership.updateOne({ userId, meetingCode }, { $set: { lastJoinedAt: new Date() } }, { upsert: true });

/** Recent meetings the user hosted or joined, newest first. */
export async function listRecentForUser(userId) {
  const memberships = await MeetingMembership.find({ userId }).sort({ lastJoinedAt: -1 }).limit(20).lean();
  if (memberships.length === 0) return [];
  const codes = memberships.map((m) => m.meetingCode);
  const meetings = await Meeting.find({ code: { $in: codes } }).lean();
  const byCode = new Map(meetings.map((m) => [m.code, toPlain(m)]));
  return memberships
    .map((m) => ({ meeting: byCode.get(m.meetingCode), lastJoinedAt: m.lastJoinedAt }))
    .filter((row) => row.meeting)
    .map((row) => ({ ...row.meeting, lastJoinedAt: row.lastJoinedAt, isHost: row.meeting.hostId === String(userId) }));
}
