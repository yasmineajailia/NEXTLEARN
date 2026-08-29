/**
 * Meeting.ts
 *
 * A single teacher-scheduled meeting with one student (online or in
 * person). Deliberately minimal: create, list, cancel — no accept/decline,
 * no reminders, no reschedule flow. A teacher schedules it from the
 * student's profile panel; the student sees it on their calendar page.
 */
import mongoose from "mongoose";

type MeetingData = {
  studentIdentifier: string;
  teacherId: mongoose.Types.ObjectId;
  teacherName: string;
  scheduledAt: Date;
  mode: "online" | "in-person";
  /** A join link for "online", a room/location for "in-person". */
  location: string;
  note?: string | null;
  status: "scheduled" | "cancelled";
};

type MeetingModel = mongoose.Model<MeetingData>;

const meetingSchema = new mongoose.Schema<MeetingData, MeetingModel>(
  {
    studentIdentifier: { type: String, required: true, trim: true, index: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "Teacher", index: true },
    teacherName: { type: String, required: true, trim: true },
    scheduledAt: { type: Date, required: true, index: true },
    mode: { type: String, enum: ["online", "in-person"], required: true },
    location: { type: String, required: true, trim: true },
    note: { type: String, default: null },
    status: {
      type: String,
      enum: ["scheduled", "cancelled"],
      default: "scheduled",
      index: true
    }
  },
  { timestamps: true }
);

meetingSchema.index({ studentIdentifier: 1, status: 1, scheduledAt: 1 });

export const Meeting =
  (mongoose.models.Meeting as MeetingModel) ||
  mongoose.model<MeetingData, MeetingModel>("Meeting", meetingSchema);
