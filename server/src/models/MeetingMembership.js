import mongoose from 'mongoose';

// One row per (user, meeting) so the dashboard can show "Recent meetings".
const membershipSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  meetingCode: { type: String, required: true },
  lastJoinedAt: { type: Date, default: Date.now },
});

membershipSchema.index({ userId: 1, meetingCode: 1 }, { unique: true });

export default mongoose.model('MeetingMembership', membershipSchema);
