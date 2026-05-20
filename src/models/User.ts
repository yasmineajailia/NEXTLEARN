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
    completedLessonKeys?: string[];
    quizResults?: Array<{
      lessonKey: string;
      moduleId: string;
      subAcquisId: string;
      score: number;
      submittedAt?: Date;
    }>;
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
            submittedAt: { type: Date, default: Date.now }
          }
        ],
        default: []
      }
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
