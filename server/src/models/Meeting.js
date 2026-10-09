import mongoose from 'mongoose';

const THIRTY_DAYS = 30 * 24 * 60 * 60;

const meetingSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, trim: true, maxlength: 80, default: '' },
    status: { type: String, enum: ['active', 'ended'], default: 'active' },
    locked: { type: Boolean, default: false },
    maxParticipants: { type: Number, required: true },
    endedAt: { type: Date, default: null },
    // Meetings nobody touched for 30 days are removed by MongoDB (TTL index).
    lastActiveAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

meetingSchema.index({ lastActiveAt: 1 }, { expireAfterSeconds: THIRTY_DAYS });

export default mongoose.model('Meeting', meetingSchema);
