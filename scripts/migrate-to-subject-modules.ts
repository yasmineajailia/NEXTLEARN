/**
 * Restructures the curriculum so that the numbered chapter documents
 * (id="1", id="2", …) — which are the acquis of "Programmation en C" —
 * are merged into a single top-level "programmation-c" CurriculumModule.
 *
 * Before:  Module "1" (Les structures conditionnelles)
 *            └─ Acquis "acq-1" (default bucket)
 *                 └─ SousAcquis "1.1", "1.2", …
 *
 * After:   Module "programmation-c" (Programmation en C)
 *            ├─ Acquis "acq-chap-1" (Les structures conditionnelles)
 *            │    └─ SousAcquis "1.1", "1.2", …
 *            ├─ Acquis "acq-chap-2" (Les structures itératives)
 *            │    └─ SousAcquis "2.1", "2.2", …
 *            └─ …
 *
 * Also migrates StudentProfile.progress.completedLessonKeys from the old
 * "N::X.Y" format to "programmation-c::X.Y".
 */

import mongoose from "mongoose";
import { env } from "../src/config/env";
import { CurriculumModule } from "../src/models/CurriculumModule";
import { StudentProfile } from "../src/models/StudentProfile";

async function main(): Promise<void> {
  if (!env.mongodbUri) {
    throw new Error("MONGODB_URI environment variable is not set");
  }

  await mongoose.connect(env.mongodbUri);

  // ── 1. Gather numeric chapter-modules ────────────────────────────────────
  const numericModules: any[] = await CurriculumModule.find()
    .lean()
    .then((docs: any[]) => docs.filter((d: any) => /^\d+$/.test(String(d.id || ""))));

  if (!numericModules.length) {
    console.log("No numeric chapter-modules found — nothing to migrate.");
    return;
  }

  numericModules.sort((a: any, b: any) => Number(a.id) - Number(b.id));
  console.log(`Found ${numericModules.length} chapter-modules to consolidate.`);

  // ── 2. Build acquis list for the new "programmation-c" module ────────────
  const acquisList = numericModules.map((mod: any) => {
    const allSousAcquis = (mod.acquis || []).flatMap((a: any) => a.sousAcquis || []);
    return {
      id: `acq-chap-${mod.id}`,
      name: mod.name || `Chapitre ${mod.id}`,
      isDefaultBucket: false,
      sousAcquis: allSousAcquis
    };
  });

  // ── 3. Create or update the "programmation-c" module ────────────────────
  const existing = await CurriculumModule.findOne({ id: "programmation-c" }).lean();
  if (existing) {
    await CurriculumModule.updateOne(
      { id: "programmation-c" },
      { $set: { acquis: acquisList, sortOrder: 0 } }
    );
    console.log("Updated existing programmation-c module.");
  } else {
    await CurriculumModule.create({
      id: "programmation-c",
      name: "Programmation en C",
      sortOrder: 0,
      acquis: acquisList
    });
    console.log("Created programmation-c module.");
  }

  // ── 4. Migrate student progress keys ─────────────────────────────────────
  const oldModuleIds = numericModules.map((m: any) => String(m.id));

  const profiles: any[] = await StudentProfile.find({
    "progress.completedLessonKeys": { $exists: true }
  }).lean();

  let migratedProfiles = 0;

  for (const profile of profiles) {
    const keys: string[] = Array.isArray(profile.progress?.completedLessonKeys)
      ? profile.progress.completedLessonKeys
      : [];

    const remapped = keys.map((key: string) => {
      const sep = key.indexOf("::");
      if (sep === -1) return key;
      const moduleId = key.slice(0, sep);
      const subId = key.slice(sep + 2);
      if (oldModuleIds.includes(moduleId)) {
        return `programmation-c::${subId}`;
      }
      return key;
    });

    const changed = remapped.some((k: string, i: number) => k !== keys[i]);
    if (!changed) continue;

    await StudentProfile.updateOne(
      { _id: profile._id },
      { $set: { "progress.completedLessonKeys": remapped } }
    );
    migratedProfiles++;
  }

  if (migratedProfiles > 0) {
    console.log(`Migrated progress keys for ${migratedProfiles} student profile(s).`);
  }

  // ── 5. Also migrate quizResults moduleId fields ───────────────────────────
  const profilesWithQuiz: any[] = await StudentProfile.find({
    "progress.quizResults": { $exists: true }
  }).lean();

  let migratedQuizProfiles = 0;

  for (const profile of profilesWithQuiz) {
    const results: any[] = Array.isArray(profile.progress?.quizResults)
      ? profile.progress.quizResults
      : [];

    const remapped = results.map((r: any) => {
      if (oldModuleIds.includes(String(r.moduleId || ""))) {
        return { ...r, moduleId: "programmation-c" };
      }
      return r;
    });

    const changed = remapped.some((r: any, i: number) => r.moduleId !== results[i].moduleId);
    if (!changed) continue;

    await StudentProfile.updateOne(
      { _id: profile._id },
      { $set: { "progress.quizResults": remapped } }
    );
    migratedQuizProfiles++;
  }

  if (migratedQuizProfiles > 0) {
    console.log(`Migrated quiz results for ${migratedQuizProfiles} student profile(s).`);
  }

  // ── 6. Delete the old numeric chapter-modules ─────────────────────────────
  const deleteResult = await CurriculumModule.deleteMany({ id: { $in: oldModuleIds } });
  console.log(`Deleted ${deleteResult.deletedCount} old chapter-module document(s).`);

  // ── 7. Fix sortOrder of all remaining modules ─────────────────────────────
  const remaining: any[] = await CurriculumModule.find()
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();

  for (let i = 0; i < remaining.length; i++) {
    await CurriculumModule.updateOne({ id: remaining[i].id }, { $set: { sortOrder: i } });
  }

  console.log("\nFinal module list:");
  remaining.forEach((m: any, i: number) => {
    const acquisCount = (m.acquis || []).length;
    console.log(`  ${i}. [${m.id}] ${m.name} (${acquisCount} acquis)`);
  });

  console.log("\nMigration complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
