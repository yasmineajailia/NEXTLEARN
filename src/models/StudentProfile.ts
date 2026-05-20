import mongoose from "mongoose";

const studentProfileSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: true,
      trim: true,
      minlength: 2
    },
    identifier: {
      type: String,
      required: true,
      trim: true,
      minlength: 3,
      unique: true
    },
    email: {
      type: String,
      required: false,
      trim: true,
      lowercase: true
    },
    classId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ClassRoom",
      required: true
    },
    lessonsCompleted: {
      type: Number,
      default: 0
    },
    quizzesTaken: {
      type: Number,
      default: 0
    },
    averageQuizGrade: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

export const StudentProfile =
  mongoose.models.StudentProfile || mongoose.model("StudentProfile", studentProfileSchema);
