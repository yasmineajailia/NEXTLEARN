import mongoose from "mongoose";
import { hashPassword as hashPasswordValue } from "../utils/password";

const teacherSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      required: true,
      enum: ["admin", "enseignant", "teacher"],
      default: "enseignant"
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      unique: true
    },
    phone: {
      type: String,
      required: true,
      trim: true,
      unique: true
    },
    password: {
      type: String,
      required: true,
      minlength: 6
    }
  },
  { timestamps: true }
);

teacherSchema.pre("save", async function hashPassword() {
  if (!this.isModified("password")) {
    return;
  }

  this.password = await hashPasswordValue(this.password);
});

teacherSchema.index({ name: 1 });

export const Teacher = mongoose.models.Teacher || mongoose.model("Teacher", teacherSchema);
