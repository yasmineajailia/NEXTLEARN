import mongoose from "mongoose";

const classRoomSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      unique: true
    },
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Teacher",
      required: true
    },
    teacherName: {
      type: String,
      required: true,
      trim: true
    },
    accessByModule: {
      type: Map,
      of: String,
      default: {}
    },
    scheduleStartDate: {
      type: Date,
      default: null
    },
    accessScheduleBySubAcquis: {
      type: Map,
      of: Date,
      default: {}
    }
  },
  { timestamps: true }
);

export const ClassRoom =
  mongoose.models.ClassRoom || mongoose.model("ClassRoom", classRoomSchema);
