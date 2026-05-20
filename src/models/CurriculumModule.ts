import mongoose from "mongoose";

const curriculumQuizQuestionSchema = new mongoose.Schema(
  {
    prompt: { type: String, required: true, trim: true },
    options: { type: [String], required: true, default: [] },
    correctAnswerIndex: { type: Number, default: null }
  },
  { _id: false }
);

const curriculumQuizSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    questions: { type: [curriculumQuizQuestionSchema], default: [] }
  },
  { _id: false }
);

const curriculumVideoSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    source: { type: String, default: "external" }
  },
  { _id: false }
);

const curriculumCourseFileSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    url: { type: String, required: true, trim: true },
    fileType: { type: String, default: "pdf" }
  },
  { _id: false }
);

const curriculumSubAcquisSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    bloomLevel: { type: String, default: "" },
    resource: {
      type: {
        type: String,
        default: ""
      },
      ref: {
        type: String,
        default: ""
      }
    },
    lessonsCount: { type: Number, default: 0 },
    courseFiles: { type: [curriculumCourseFileSchema], default: [] },
    videos: { type: [curriculumVideoSchema], default: [] },
    quizzes: { type: [curriculumQuizSchema], default: [] }
  },
  { _id: false }
);

const curriculumAcquisSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    isDefaultBucket: { type: Boolean, default: false },
    sousAcquis: { type: [curriculumSubAcquisSchema], default: [] }
  },
  { _id: false }
);

const curriculumModuleSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    sortOrder: { type: Number, default: 0 },
    acquis: { type: [curriculumAcquisSchema], default: [] }
  },
  { timestamps: true }
);

export const CurriculumModule =
  mongoose.models.CurriculumModule ||
  mongoose.model("CurriculumModule", curriculumModuleSchema);
