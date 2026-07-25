/**
 * Seeds a demo class with ~18 fake students spread across three clearly
 * distinct behavioral profiles (Avancés / En progression / En difficulté)
 * so the K-Means clustering dashboard has something meaningful to show.
 *
 * Safe to re-run: it wipes only its own "demo.eleve*" accounts before
 * recreating them, and reuses an existing class/teacher instead of
 * duplicating them.
 *
 * Usage: npm run seed:clustering-demo
 */

import mongoose from "mongoose";
import { env } from "../src/config/env";
import { Teacher } from "../src/models/Teacher";
import { ClassRoom } from "../src/models/ClassRoom";
import { StudentProfile } from "../src/models/StudentProfile";
import { User } from "../src/models/User";
import { CurriculumModule } from "../src/models/CurriculumModule";

const DEMO_IDENTIFIER_PREFIX = "demo.eleve";
const DEMO_CLASS_NAME = "Classe Démo — Clustering";
const PREFERRED_CLASS_NAME = "1A7";
const DEMO_PASSWORD = "Demo1234";
const FALLBACK_TEACHER = {
  role: "enseignant" as const,
  name: "Enseignant Démo",
  email: "demo.prof@nextlearn-demo.tn",
  phone: "+21620000099",
  password: DEMO_PASSWORD
};

const NOW = new Date();

const STUDENT_NAMES = [
  "Amine Ben Salah", "Yasmine Trabelsi", "Sami Khalfaoui", "Nour Gharbi", "Karim Bouazizi",
  "Rania Mejri", "Wassim Chaabane", "Emna Sassi", "Mehdi Ayari", "Ines Kammoun",
  "Bilel Jendoubi", "Salma Rekik", "Oussama Hammami", "Marwa Fendri", "Anis Bouhlel",
  "Dorra Ben Amor", "Firas Guesmi", "Hela Zouari"
];

type Archetype = {
  key: string;
  count: number;
  completionRange: [number, number];
  scoreRange: [number, number];
  quizCoverageRange: [number, number];
  attemptsRange: [number, number];
  loginsPerWeekRange: [number, number];
  lastLoginRecencyDaysRange: [number, number];
  recentQuizShare: number;
};

const ARCHETYPES: Archetype[] = [
  {
    key: "avance",
    count: 6,
    completionRange: [0.7, 0.95],
    scoreRange: [78, 97],
    quizCoverageRange: [0.8, 1.0],
    attemptsRange: [1, 2],
    loginsPerWeekRange: [4, 6.5],
    lastLoginRecencyDaysRange: [0, 3],
    recentQuizShare: 0.7
  },
  {
    key: "progression",
    count: 6,
    completionRange: [0.3, 0.55],
    scoreRange: [55, 72],
    quizCoverageRange: [0.5, 0.8],
    attemptsRange: [1, 3],
    loginsPerWeekRange: [1.5, 3],
    lastLoginRecencyDaysRange: [3, 10],
    recentQuizShare: 0.4
  },
  {
    key: "difficulte",
    count: 6,
    completionRange: [0.03, 0.22],
    scoreRange: [20, 48],
    quizCoverageRange: [0.3, 0.7],
    attemptsRange: [1, 4],
    loginsPerWeekRange: [0.1, 1.2],
    lastLoginRecencyDaysRange: [10, 35],
    recentQuizShare: 0.1
  }
];

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function pickRandom<T>(range: [number, number]): number {
  return randomFloat(range[0], range[1]);
}

function shuffle<T>(items: T[]): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// --- VARK learning-style overlay -------------------------------------------
// Each behavioral archetype gets a *different* weighting over the four styles
// so the clustering VARK overlay tells a story (e.g. struggling students skew
// kinesthetic/auditory rather than read/write). ~15% of students are left
// without a profile to exercise the "X/Y renseignés" partial state.
const VARK_KEYS = ["visual", "auditory", "readwrite", "kinesthetic"] as const;
type VarkKey = (typeof VARK_KEYS)[number];

const VARK_WEIGHTS: Record<string, Record<VarkKey, number>> = {
  avance: { visual: 3, auditory: 2, readwrite: 4, kinesthetic: 1 },
  progression: { visual: 3, auditory: 3, readwrite: 2, kinesthetic: 2 },
  difficulte: { visual: 2, auditory: 3, readwrite: 1, kinesthetic: 4 }
};

function weightedPickVark(weights: Record<VarkKey, number>): VarkKey {
  const total = VARK_KEYS.reduce((sum, key) => sum + weights[key], 0);
  let roll = Math.random() * total;
  for (const key of VARK_KEYS) {
    roll -= weights[key];
    if (roll <= 0) return key;
  }
  return "visual";
}

function buildVarkProfile(archetypeKey: string) {
  if (Math.random() < 0.15) return null; // hasn't taken the questionnaire yet
  const weights = VARK_WEIGHTS[archetypeKey] || VARK_WEIGHTS.progression;
  const dominant = weightedPickVark(weights);
  const scores = VARK_KEYS.reduce((acc, key) => {
    acc[key] = key === dominant ? randomInt(60, 90) : randomInt(20, 55);
    return acc;
  }, {} as Record<VarkKey, number>);
  return { dominant, scores, completedAt: daysAgo(randomInt(1, 25)) };
}

type SubAcquisRef = { moduleId: string; subAcquisId: string };

/** Flattens every sous-acquis across every curriculum module into a flat pool. */
async function resolveSubAcquisPool(): Promise<SubAcquisRef[]> {
  const modules = await CurriculumModule.find().lean();
  const pool: SubAcquisRef[] = [];
  for (const moduleDoc of modules as any[]) {
    for (const acquis of Array.isArray(moduleDoc.acquis) ? moduleDoc.acquis : []) {
      for (const sub of Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : []) {
        if (sub?.id) pool.push({ moduleId: moduleDoc.id, subAcquisId: sub.id });
      }
    }
  }
  return pool;
}

async function resolveTeacherId(): Promise<{ teacherId: string; email: string; usedFallback: boolean }> {
  const known = await Teacher.findOne({ email: "teacher@esprit.tn" }).lean();
  if (known) return { teacherId: String(known._id), email: known.email, usedFallback: false };

  const anyTeacher = await Teacher.findOne().lean();
  if (anyTeacher) return { teacherId: String(anyTeacher._id), email: anyTeacher.email, usedFallback: false };

  const created = await Teacher.create(FALLBACK_TEACHER);
  return { teacherId: String(created._id), email: created.email, usedFallback: true };
}

/**
 * Picks the class demo students should land in. Prefers an existing class
 * named `PREFERRED_CLASS_NAME` (so demo students live alongside real ones
 * in a class you already use day-to-day); falls back to creating/reusing a
 * dedicated demo class when that preferred class doesn't exist.
 */
async function resolveTargetClass(): Promise<{ classId: string; teacherEmail: string }> {
  const preferred = await ClassRoom.findOne({ name: PREFERRED_CLASS_NAME }).lean();
  if (preferred) {
    const owner = preferred.teacherId ? await Teacher.findById(preferred.teacherId).lean() : null;
    return { classId: String(preferred._id), teacherEmail: (owner as any)?.email || "(enseignant existant)" };
  }

  const { teacherId, email, usedFallback } = await resolveTeacherId();
  const teacher = await Teacher.findById(teacherId).lean();

  const existingDemoClass = await ClassRoom.findOne({ name: DEMO_CLASS_NAME }).lean();
  const classId = existingDemoClass
    ? String(existingDemoClass._id)
    : String(
        (
          await ClassRoom.create({
            name: DEMO_CLASS_NAME,
            teacherId,
            teacherName: (teacher as any)?.name || "Enseignant Démo"
          })
        )._id
      );

  return { classId, teacherEmail: `${email}${usedFallback ? ` (créé, mot de passe: ${DEMO_PASSWORD})` : ""}` };
}

/** Removes the dedicated demo class if it's left empty (e.g. after demo students were moved into PREFERRED_CLASS_NAME). */
async function cleanupEmptyDemoClass(): Promise<void> {
  const demoClass = await ClassRoom.findOne({ name: DEMO_CLASS_NAME }).lean();
  if (!demoClass) return;
  const remaining = await StudentProfile.countDocuments({ classId: demoClass._id });
  if (remaining === 0) {
    await ClassRoom.deleteOne({ _id: demoClass._id });
  }
}

type QuizSubmission = { moduleId: string; subAcquisId: string; score: number; submittedAt: Date };

function generateQuizSubmissions(item: SubAcquisRef, archetype: Archetype, createdAt: Date): QuizSubmission[] {
  const finalScore = clamp(pickRandom(archetype.scoreRange), 0, 100);
  const attempts = randomInt(archetype.attemptsRange[0], archetype.attemptsRange[1]);
  const isRecent = Math.random() < archetype.recentQuizShare;

  const finalDate = isRecent
    ? daysAgo(randomInt(0, 13))
    : daysAgo(randomInt(14, Math.max(15, Math.floor((NOW.getTime() - createdAt.getTime()) / (24 * 60 * 60 * 1000)))));

  const submissions: QuizSubmission[] = [];
  for (let attemptIndex = 0; attemptIndex < attempts - 1; attemptIndex++) {
    const earlierScore = clamp(finalScore - randomInt(10, 35) * (attempts - attemptIndex), 0, 100);
    const earlierDate = new Date(finalDate.getTime() - (attempts - attemptIndex) * 2 * 24 * 60 * 60 * 1000);
    submissions.push({
      moduleId: item.moduleId,
      subAcquisId: item.subAcquisId,
      score: earlierScore,
      submittedAt: earlierDate.getTime() > createdAt.getTime() ? earlierDate : createdAt
    });
  }
  submissions.push({ moduleId: item.moduleId, subAcquisId: item.subAcquisId, score: finalScore, submittedAt: finalDate });

  return submissions;
}

function buildStudent(index: number, archetype: Archetype, subAcquisPool: SubAcquisRef[], classId: string) {
  const identifier = `${DEMO_IDENTIFIER_PREFIX}${String(index + 1).padStart(2, "0")}`;
  const fullName = STUDENT_NAMES[index % STUDENT_NAMES.length];
  const email = `${identifier}@nextlearn-demo.tn`;

  const weeksSinceCreation = randomInt(4, 16);
  const createdAt = daysAgo(weeksSinceCreation * 7);

  const completionRate = pickRandom(archetype.completionRange);
  const numCompleted = clamp(Math.round(completionRate * subAcquisPool.length), 1, subAcquisPool.length);
  const completedItems = shuffle(subAcquisPool).slice(0, numCompleted);

  const quizCoverage = pickRandom(archetype.quizCoverageRange);
  const itemsWithQuiz = completedItems.slice(0, Math.max(1, Math.round(completedItems.length * quizCoverage)));

  const quizResults = itemsWithQuiz.flatMap((item) => generateQuizSubmissions(item, archetype, createdAt));
  const finalScores = itemsWithQuiz.map((_item, i) => {
    // The last submission generated per item is always its final (highest-index) attempt.
    const forItem = quizResults.filter((q) => q.moduleId === itemsWithQuiz[i].moduleId && q.subAcquisId === itemsWithQuiz[i].subAcquisId);
    return forItem[forItem.length - 1].score;
  });

  const loginsPerWeek = pickRandom(archetype.loginsPerWeekRange);
  const loginCount = Math.max(0, Math.round(loginsPerWeek * weeksSinceCreation));
  const lastLoginDate = daysAgo(randomInt(archetype.lastLoginRecencyDaysRange[0], archetype.lastLoginRecencyDaysRange[1]));

  const averageQuizGrade = finalScores.length
    ? Math.round(finalScores.reduce((sum, s) => sum + s, 0) / finalScores.length)
    : 0;
  const xp = numCompleted * 10 + quizResults.length * 5;

  const userDoc = {
    fullName,
    identifier,
    email,
    password: DEMO_PASSWORD,
    createdAt,
    varkProfile: buildVarkProfile(archetype.key),
    progress: {
      xp,
      completedLessonKeys: completedItems.map((item) => `${item.moduleId}::${item.subAcquisId}`),
      quizResults: quizResults.map((q) => ({
        lessonKey: `${q.moduleId}::${q.subAcquisId}`,
        moduleId: q.moduleId,
        subAcquisId: q.subAcquisId,
        score: Math.round(q.score),
        submittedAt: q.submittedAt
      }))
    }
  };

  const profileDoc = {
    fullName,
    identifier,
    email,
    classId,
    lessonsCompleted: numCompleted,
    quizzesTaken: itemsWithQuiz.length,
    averageQuizGrade,
    xp,
    loginCount,
    lastLoginDate,
    createdAt
  };

  return { userDoc, profileDoc, archetype: archetype.key };
}

async function main(): Promise<void> {
  if (!env.mongodbUri) {
    throw new Error("MONGODB_URI environment variable is not set");
  }

  await mongoose.connect(env.mongodbUri);

  const subAcquisPool = await resolveSubAcquisPool();
  if (subAcquisPool.length === 0) {
    throw new Error(
      "Aucun sous-acquis trouvé dans CurriculumModule — seedez d'abord le curriculum (ex: npm run seed:modules / migrate:subject-modules) avant de générer des données de démonstration."
    );
  }

  const { classId, teacherEmail } = await resolveTargetClass();
  const targetClass = await ClassRoom.findById(classId).lean();
  const className = (targetClass as any)?.name || PREFERRED_CLASS_NAME;

  // Idempotent: wipe only this script's own demo accounts before recreating them.
  await User.deleteMany({ identifier: { $regex: `^${DEMO_IDENTIFIER_PREFIX}` } });
  await StudentProfile.deleteMany({ identifier: { $regex: `^${DEMO_IDENTIFIER_PREFIX}` } });
  await cleanupEmptyDemoClass();

  const students: Array<ReturnType<typeof buildStudent>> = [];
  let cursor = 0;
  for (const archetype of ARCHETYPES) {
    for (let i = 0; i < archetype.count; i++) {
      students.push(buildStudent(cursor, archetype, subAcquisPool, classId));
      cursor++;
    }
  }

  const createdUsers = await User.create(students.map((s) => s.userDoc));
  await StudentProfile.create(students.map((s) => s.profileDoc));

  // Force-backdate createdAt (some Mongoose versions/hook orders can override
  // an explicitly-provided createdAt on creation) so weeklyLoginFrequency
  // is computed against a realistic account age rather than "just now".
  await User.bulkWrite(
    students.map((s, i) => ({
      updateOne: { filter: { _id: createdUsers[i]._id }, update: { $set: { createdAt: s.userDoc.createdAt } } }
    }))
  );
  await StudentProfile.bulkWrite(
    students.map((s) => ({
      updateOne: { filter: { identifier: s.profileDoc.identifier }, update: { $set: { createdAt: s.profileDoc.createdAt } } }
    }))
  );

  console.log(`\nClasse: "${className}" (${classId})`);
  console.log(`Enseignant propriétaire: ${teacherEmail}`);
  console.log(`Sous-acquis disponibles dans le curriculum: ${subAcquisPool.length}`);
  console.log(`\n${students.length} étudiants de démonstration créés:`);

  for (const archetype of ARCHETYPES) {
    const group = students.filter((s) => s.archetype === archetype.key);
    console.log(`  - ${archetype.key}: ${group.length} étudiants`);
  }

  console.log(`\nMot de passe (comptes étudiants démo): ${DEMO_PASSWORD}`);
  console.log(`\nPour tester le clustering: connectez-vous au backoffice (${teacherEmail}), ouvrez`);
  console.log(`"Profils d'apprentissage" et sélectionnez la pastille "${className}".`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
