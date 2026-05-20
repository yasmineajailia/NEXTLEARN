import mongoose from "mongoose";

type RemediationQuestion = {
  sourceQuestionIndex: number;
  prompt: string;
  options: string[];
  correctOptionIndex: number;
};

type StudentRemediationQuizData = {
  identifier: string;
  moduleId: string;
  subAcquisId: string;
  sourceSubmittedAt: Date;
  status: "active" | "completed" | "expired";
  wrongQuestionIndexes: number[];
  retryNumber: number;
  questions: RemediationQuestion[];
  jsonFilePath?: string | null;
  jsonFileName?: string | null;
  expiresAt?: Date | null;
};

type StudentRemediationQuizModel = mongoose.Model<StudentRemediationQuizData>;

const remediationQuestionSchema = new mongoose.Schema<RemediationQuestion>(
  {
    sourceQuestionIndex: { type: Number, required: true },
    prompt: { type: String, required: true, trim: true },
    options: { type: [String], required: true, default: [] },
    correctOptionIndex: { type: Number, required: true }
  },
  { _id: false }
);

const studentRemediationQuizSchema = new mongoose.Schema<StudentRemediationQuizData, StudentRemediationQuizModel>(
  {
    identifier: { type: String, required: true, trim: true, index: true },
    moduleId: { type: String, required: true, trim: true, index: true },
    subAcquisId: { type: String, required: true, trim: true, index: true },
    sourceSubmittedAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["active", "completed", "expired"],
      default: "active",
      index: true
    },
    wrongQuestionIndexes: { type: [Number], default: [] },
    retryNumber: { type: Number, default: 1 },
    questions: { type: [remediationQuestionSchema], default: [] },
    jsonFilePath: { type: String, default: null },
    jsonFileName: { type: String, default: null },
    expiresAt: { type: Date, default: null }
  },
  { timestamps: true }
);

studentRemediationQuizSchema.index({ identifier: 1, moduleId: 1, subAcquisId: 1, status: 1 });

export const StudentRemediationQuiz =
  (mongoose.models.StudentRemediationQuiz as StudentRemediationQuizModel) ||
  mongoose.model<StudentRemediationQuizData, StudentRemediationQuizModel>(
    "StudentRemediationQuiz",
    studentRemediationQuizSchema
  );
