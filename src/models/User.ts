import mongoose from "mongoose";
import { comparePassword as comparePasswordHash, hashPassword as hashPasswordValue } from "../utils/password";

type UserData = {
  fullName: string;
  identifier: string;
  email: string;
  password: string;
  passwordResetTokenHash?: string | null;
  passwordResetExpiresAt?: Date | null;
  progress?: {
    xp?: number;
    completedLessonKeys?: string[];
    quizResults?: Array<{
      lessonKey: string;
      moduleId: string;
      subAcquisId: string;
      score: number;
      attempts?: number;
      submittedAt?: Date;
    }>;
    selfEvaluationResults?: Array<{
      moduleId: string;
      acquisId: string;
      score: number;
      passed: boolean;
      timeSpent?: number;
      xpEarned?: number;
      submittedAt?: Date;
    }>;
    attentionSessions?: Array<{
      sessionId: string;
      context: "lesson" | "quiz";
      moduleId?: string;
      subAcquisId?: string;
      duration: number;
      avgFocusScore: number;
      minFocusScore?: number;
      distractionEvents?: Array<{ t: number; reason: string; duration: number }>;
      focusTimeline?: Array<{ t: number; score: number }>;
      completedAt?: Date;
    }>;
    avgFocusScore?: number | null;
  };
};

type UserMethods = {
  comparePassword: (candidatePassword: string) => Promise<boolean>;
};

type UserModel = mongoose.Model<UserData, object, UserMethods>;

const userSchema = new mongoose.Schema<UserData, UserModel, UserMethods>(
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
      unique: true,
      trim: true,
      minlength: 3
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true
    },
    password: {
      type: String,
      required: true,
      minlength: 6
    },
    passwordResetTokenHash: {
      type: String,
      default: null
    },
    passwordResetExpiresAt: {
      type: Date,
      default: null
    },
    progress: {
      xp: {
        type: Number,
        default: 0
      },
      completedLessonKeys: {
        type: [String],
        default: []
      },
      quizResults: {
        type: [
          {
            lessonKey: { type: String, required: true },
            moduleId: { type: String, required: true },
            subAcquisId: { type: String, required: true },
            score: { type: Number, required: true },
            attempts: { type: Number, default: 1 },
            submittedAt: { type: Date, default: Date.now }
          }
        ],
        default: []
      },
      selfEvaluationResults: {
        type: [
          {
            moduleId: { type: String, required: true },
            acquisId: { type: String, required: true },
            score: { type: Number, required: true },
            passed: { type: Boolean, required: true },
            timeSpent: { type: Number, default: 0 },
            xpEarned: { type: Number, default: 0 },
            submittedAt: { type: Date, default: Date.now }
          }
        ],
        default: []
      },
      attentionSessions: {
        type: [
          {
            sessionId: String,
            context: { type: String, enum: ["lesson", "quiz"] },
            moduleId: String,
            subAcquisId: String,
            duration: Number,
            avgFocusScore: Number,
            minFocusScore: Number,
            distractionEvents: [{ t: Number, reason: String, duration: Number }],
            focusTimeline: [{ t: Number, score: Number }],
            completedAt: Date
          }
        ],
        default: []
      },
      avgFocusScore: { type: Number, default: null }
    }
  },
  { timestamps: true }
);

userSchema.pre("save", async function hashPassword() {
  if (!this.isModified("password")) {
    return;
  }

  this.password = await hashPasswordValue(this.password);
});

userSchema.methods.comparePassword = function comparePassword(candidatePassword: string): Promise<boolean> {
  return comparePasswordHash(candidatePassword, this.password);
};

export const User =
  (mongoose.models.User as UserModel) || mongoose.model<UserData, UserModel>("User", userSchema);
