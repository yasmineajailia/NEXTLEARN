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
    /**
     * Append-only history of every quiz attempt, kept as a SEQUENCE (unlike
     * quizResults, which retains only the latest per lessonKey). This is the raw
     * material for mastery estimation and item analysis: per-attempt
     * pass/fail plus per-question responses. Capped to the most recent 200.
     */
    skillAttempts?: Array<{
      lessonKey: string;
      moduleId: string;
      subAcquisId: string;
      score: number;
      correct: boolean;
      attempts?: number;
      responses?: Array<{
        questionIndex: number;
        selectedIndex: number;
        correct: boolean;
        gradable: boolean;
      }>;
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
    /**
     * NLP-derived signals from the "explain it in your own words" box: for each
     * submission, the concept-coverage score of the student's free-text
     * explanation vs the lesson's own content (semantic gap analysis). A low
     * score is a text-derived weak signal that quiz scores may miss; it feeds
     * the learner profile / recommendations. Capped to the most recent 50.
     */
    textSignals?: Array<{
      moduleId: string;
      subAcquisId: string;
      score: number;
      band: "acquired" | "partial" | "gap";
      missingConcepts?: string[];
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
      /** Average focus per content type viewed during the session (0-100). */
      focusByContent?: { video?: number; support?: number; quiz?: number };
      distractionEvents?: Array<{ t: number; reason: string; duration: number }>;
      focusTimeline?: Array<{ t: number; score: number }>;
      completedAt?: Date;
    }>;
    avgFocusScore?: number | null;
  };
  /**
   * Persisted VARK learning-style result from the "Mission Apprenant" game.
   * Client-side localStorage stays the fast path; this server copy makes it
   * durable (survives cache clears / new devices) and readable by the backoffice
   * (per-class analytics). `dominant` drives resource ordering on lesson pages.
   */
  varkProfile?: {
    dominant: "visual" | "readwrite" | "auditory" | "kinesthetic";
    scores: { visual: number; readwrite: number; auditory: number; kinesthetic: number };
    completedAt?: Date;
  } | null;
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
      skillAttempts: {
        type: [
          {
            lessonKey: { type: String, required: true },
            moduleId: { type: String, required: true },
            subAcquisId: { type: String, required: true },
            score: { type: Number, required: true },
            correct: { type: Boolean, required: true },
            attempts: { type: Number, default: 1 },
            responses: [
              {
                questionIndex: { type: Number, required: true },
                selectedIndex: { type: Number, default: -1 },
                correct: { type: Boolean, default: false },
                gradable: { type: Boolean, default: true }
              }
            ],
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
      textSignals: {
        type: [
          {
            moduleId: { type: String, required: true },
            subAcquisId: { type: String, required: true },
            score: { type: Number, required: true },
            band: { type: String, enum: ["acquired", "partial", "gap"], required: true },
            missingConcepts: { type: [String], default: [] },
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
            focusByContent: { video: Number, support: Number, quiz: Number },
            distractionEvents: [{ t: Number, reason: String, duration: Number }],
            focusTimeline: [{ t: Number, score: Number }],
            completedAt: Date
          }
        ],
        default: []
      },
      avgFocusScore: { type: Number, default: null }
    },
    varkProfile: {
      type: new mongoose.Schema(
        {
          dominant: {
            type: String,
            enum: ["visual", "readwrite", "auditory", "kinesthetic"],
            required: true
          },
          scores: {
            visual: { type: Number, default: 0 },
            readwrite: { type: Number, default: 0 },
            auditory: { type: Number, default: 0 },
            kinesthetic: { type: Number, default: 0 }
          },
          completedAt: { type: Date, default: Date.now }
        },
        { _id: false }
      ),
      default: null
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
