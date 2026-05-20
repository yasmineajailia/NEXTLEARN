import mongoose from "mongoose";
import { env } from "../src/config/env";
import { Teacher } from "../src/models/Teacher";

type SeedTeacher = {
  role: "admin" | "enseignant";
  name: string;
  email: string;
  phone: string;
  password: string;
};

const seedTeachers: SeedTeacher[] = [
  {
    role: "admin",
    name: "Admin ESPRIT",
    email: "admin@esprit.tn",
    phone: "+21620000090",
    password: "123456"
  },
  {
    role: "enseignant",
    name: "Enseignant ESPRIT",
    email: "teacher@esprit.tn",
    phone: "+21620000091",
    password: "123456"
  }
];

const legacySeedEmails = ["admin@nextlearn.tn", "teacher@nextlearn.tn"];

async function removeLegacySeedAccounts(): Promise<void> {
  await Teacher.deleteMany({ email: { $in: legacySeedEmails } });
}

async function upsertTeacher(seed: SeedTeacher): Promise<void> {
  const existing = await Teacher.findOne({ email: seed.email });

  if (!existing) {
    await Teacher.create(seed);
    return;
  }

  existing.role = seed.role;
  existing.name = seed.name;
  existing.phone = seed.phone;
  existing.password = seed.password;
  await existing.save();
}

async function main(): Promise<void> {
  if (!env.mongodbUri) {
    throw new Error("MONGODB_URI environment variable is not set");
  }

  await mongoose.connect(env.mongodbUri);

  await removeLegacySeedAccounts();

  for (const seed of seedTeachers) {
    await upsertTeacher(seed);
  }

  console.log("Seeded login users:");
  seedTeachers.forEach((seed) => {
    console.log(`${seed.role}: ${seed.email} / ${seed.password}`);
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });