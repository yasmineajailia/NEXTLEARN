import mongoose from "mongoose";

export type StudentChatbotVectorKind =
  | "module"
  | "sub-acquis"
  | "quiz"
  | "video"
  | "course-file"
  | "course-content";

export type StudentChatbotVectorData = {
  chunkId: string;
  moduleId: string;
  moduleName: string;
  subAcquisId: string | null;
  subAcquisName: string | null;
  kind: StudentChatbotVectorKind;
  text: string;
  contentHash: string;
  embedding: number[];
};

const studentChatbotVectorSchema = new mongoose.Schema<StudentChatbotVectorData>(
  {
    chunkId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    moduleId: {
      type: String,
      required: true,
      index: true
    },
    moduleName: {
      type: String,
      required: true,
      trim: true
    },
    subAcquisId: {
      type: String,
      default: null,
      index: true
    },
    subAcquisName: {
      type: String,
      default: null,
      trim: true
    },
    kind: {
      type: String,
      required: true,
      enum: ["module", "sub-acquis", "quiz", "video", "course-file", "course-content"],
      index: true
    },
    text: {
      type: String,
      required: true
    },
    contentHash: {
      type: String,
      required: true,
      index: true
    },
    embedding: {
      type: [Number],
      required: true
    }
  },
  { timestamps: true }
);

studentChatbotVectorSchema.index({ moduleId: 1, subAcquisId: 1, kind: 1 });

export const StudentChatbotVector =
  mongoose.models.StudentChatbotVector ||
  mongoose.model<StudentChatbotVectorData>("StudentChatbotVector", studentChatbotVectorSchema);