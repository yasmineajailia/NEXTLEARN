/**
 * Seeds several demo CLASSES (each owned by a teacher) filled with students so
 * the back office doesn't look empty for a demo: the classes list, student
 * rosters, the K-Means clustering dashboard and the attention analytics all
 * get realistic data.
 *
 * It creates two teachers and three classes with different strength profiles
 * (a strong class, an average one, a struggling one). Each student gets
 * progress + quiz history + a handful of attention sessions.
 *
 * Safe to re-run: it wipes only its own "demo.cls*" accounts before recreating
 * them, and reuses classes/teachers by name/email instead of duplicating them.
 * It does NOT touch your real data or the separate clustering-demo students.
 *
 * Prereq: the curriculum must be seeded (npm run seed:modules).
 * Usage:   npm run seed:demo-classes
 */
import mongoose from "mongoose";
import { env } from "../src/config/env";
import { Teacher } from "../src/models/Teacher";
import { ClassRoom } from "../src/models/ClassRoom";
import { StudentProfile } from "../src/models/StudentProfile";
import { User } from "../src/models/User";
import { CurriculumModule } from "../src/models/CurriculumModule";

const STUDENT_PREFIX = "demo.cls";
const DEMO_PASSWORD = "Demo1234";
const NOW = new Date();

const DEMO_TEACHERS = [
  { name: "Salma Bouzid", email: "prof.bouzid@esprit.tn", phone: "+21620000091" },
  { name: "Karim Haddad", email: "prof.haddad@esprit.tn", phone: "+21620000092" }
];

// mix = how many students of each behavioral profile the class contains.
const CLASSES = [
  { name: "1A7", teacher: 0, mix: { avance: 5, progression: 4, difficulte: 2 } }, // strong
  { name: "1A8", teacher: 0, mix: { avance: 2, progression: 5, difficulte: 3 } }, // average
  { name: "2B3", teacher: 1, mix: { avance: 1, progression: 3, difficulte: 6 } }  // struggling
];

const FIRST_NAMES = [
  "Amine", "Yasmine", "Sami", "Nour", "Karim", "Rania", "Wassim", "Emna", "Mehdi", "Ines",
  "Bilel", "Salma", "Oussama", "Marwa", "Anis", "Dorra", "Firas", "Hela", "Skander", "Aya",
  "Ghassen", "Maryem", "Youssef", "Rim", "Hamza", "Sirine", "Nizar", "Farah", "Zied", "Asma"
];
const LAST_NAMES = [
  "Ben Salah", "Trabelsi", "Khalfaoui", "Gharbi", "Bouazizi", "Mejri", "Chaabane", "Sassi",
  "Ayari", "Kammoun", "Jendoubi", "Rekik", "Hammami", "Fendri", "Bouhlel", "Ben Amor",
  "Guesmi", "Zouari", "Mabrouk", "Nasri", "Cherif", "Dridi", "Baccouche", "Tounsi"
];

type ArchetypeKey = "avance" | "progression" | "difficulte";
type Archetype = {
  key: ArchetypeKey;
  completionRange: [number, number];
  scoreRange: [number, number];
  quizCoverageRange: [number, number];
  attemptsRange: [number, number];
  loginsPerWeekRange: [number, number];
  lastLoginRecencyDaysRange: [number, number];
  focusRange: [number, number];
  sessionsRange: [number, number];
  recentQuizShare: number;
};

const ARCHETYPES: Record<ArchetypeKey, Archetype> = {
  avance: {
    key: "avance", completionRange: [0.7, 0.95], scoreRange: [78, 97], quizCoverageRange: [0.8, 1.0],
    attemptsRange: [1, 2], loginsPerWeekRange: [4, 6.5], lastLoginRecencyDaysRange: [0, 3],
    focusRange: [76, 95], sessionsRange: [8, 14], recentQuizShare: 0.7
  },
  progression: {
    key: "progression", completionRange: [0.3, 0.55], scoreRange: [55, 72], quizCoverageRange: [0.5, 0.8],
    attemptsRange: [1, 3], loginsPerWeekRange: [1.5, 3], lastLoginRecencyDaysRange: [3, 10],
    focusRange: [56, 78], sessionsRange: [5, 10], recentQuizShare: 0.4
  },
  difficulte: {
    key: "difficulte", completionRange: [0.03, 0.22], scoreRange: [20, 48], quizCoverageRange: [0.3, 0.7],
    attemptsRange: [1, 4], loginsPerWeekRange: [0.1, 1.2], lastLoginRecencyDaysRange: [10, 35],
    focusRange: [32, 58], sessionsRange: [3, 8], recentQuizShare: 0.1
  }
};

const DISTRACTION_REASONS = ["gaze_away", "head_turned", "eyes_closed", "no_face"];

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const randFloat = (min: number, max: number) => Math.random() * (max - min) + min;
const pick = (r: [number, number]) => randFloat(r[0], r[1]);
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 864e5);
const pickOne = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
function shuffle<T>(items: T[]): T[] {
  const c = items.slice();
  for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; }
  return c;
}

type SubAcquisRef = { moduleId: string; subAcquisId: string };

async function resolveSubAcquisPool(): Promise<SubAcquisRef[]> {
  const modules = await CurriculumModule.find().lean();
  const pool: SubAcquisRef[] = [];
  for (const m of modules as any[]) {
    for (const acquis of Array.isArray(m.acquis) ? m.acquis : []) {
      for (const sub of Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : []) {
        if (sub?.id) pool.push({ moduleId: m.id, subAcquisId: sub.id });
      }
    }
  }
  return pool;
}

async function uniquePhone(preferred: string): Promise<string> {
  let phone = preferred;
  while (await Teacher.findOne({ phone })) phone = `+2169${randInt(1000000, 9999999)}`;
  return phone;
}

async function uniqueEmail(preferred: string): Promise<string> {
  if (!(await Teacher.findOne({ email: preferred }))) return preferred;
  return `demo.prof.${randInt(1000, 9999)}@nextlearn-demo.tn`;
}

/**
 * Two teachers to own the demo classes. Prefers your existing teacher accounts
 * (so you can log in as them and see the classes filled); only creates demo
 * teachers to reach two, with guaranteed-unique email + phone.
 */
async function resolveTeachers(): Promise<Array<{ id: string; name: string; email: string; created: boolean }>> {
  const owners: Array<{ id: string; name: string; email: string; created: boolean }> = [];

  const existing = await Teacher.find({ role: { $in: ["enseignant", "teacher"] } }).lean();
  for (const t of existing as any[]) {
    owners.push({ id: String(t._id), name: t.name, email: t.email, created: false });
    if (owners.length === 2) break;
  }

  let i = 0;
  while (owners.length < 2) {
    const cfg = DEMO_TEACHERS[i % DEMO_TEACHERS.length];
    const email = await uniqueEmail(cfg.email);
    const phone = await uniquePhone(cfg.phone);
    const created = await Teacher.create({ role: "enseignant", name: cfg.name, email, phone, password: DEMO_PASSWORD });
    owners.push({ id: String(created._id), name: cfg.name, email, created: true });
    i++;
  }
  return owners;
}

async function resolveClass(name: string, teacherId: string, teacherName: string): Promise<string> {
  const existing = await ClassRoom.findOne({ name }).lean();
  if (existing) return String((existing as any)._id);
  const created = await ClassRoom.create({ name, teacherId, teacherName });
  return String(created._id);
}

type QuizSubmission = { moduleId: string; subAcquisId: string; score: number; submittedAt: Date };

function generateQuizSubmissions(item: SubAcquisRef, a: Archetype, createdAt: Date): QuizSubmission[] {
  const finalScore = clamp(pick(a.scoreRange), 0, 100);
  const attempts = randInt(a.attemptsRange[0], a.attemptsRange[1]);
  const isRecent = Math.random() < a.recentQuizShare;
  const finalDate = isRecent
    ? daysAgo(randInt(0, 13))
    : daysAgo(randInt(14, Math.max(15, Math.floor((NOW.getTime() - createdAt.getTime()) / 864e5))));
  const out: QuizSubmission[] = [];
  for (let k = 0; k < attempts - 1; k++) {
    const earlier = clamp(finalScore - randInt(10, 35) * (attempts - k), 0, 100);
    const d = new Date(finalDate.getTime() - (attempts - k) * 2 * 864e5);
    out.push({ ...item, score: earlier, submittedAt: d.getTime() > createdAt.getTime() ? d : createdAt });
  }
  out.push({ ...item, score: finalScore, submittedAt: finalDate });
  return out;
}

function generateAttentionSessions(identifier: string, a: Archetype, pool: SubAcquisRef[]) {
  const count = randInt(a.sessionsRange[0], a.sessionsRange[1]);
  const sessions = [];
  for (let i = 0; i < count; i++) {
    const item = pickOne(pool);
    const avg = clamp(Math.round(pick(a.focusRange)), 0, 100);
    const nDistract = clamp(Math.round((100 - avg) / 22) + randInt(0, 2), 0, 6);
    const distractionEvents = Array.from({ length: nDistract }, () => ({
      t: randInt(5, 1200), reason: pickOne(DISTRACTION_REASONS), duration: randInt(2, 18)
    }));
    sessions.push({
      sessionId: `${identifier}-att${i + 1}`,
      context: Math.random() < 0.6 ? "lesson" : "quiz",
      moduleId: item.moduleId,
      subAcquisId: item.subAcquisId,
      duration: randInt(120, 1500),
      avgFocusScore: avg,
      minFocusScore: clamp(avg - randInt(10, 35), 0, 100),
      distractionEvents,
      focusTimeline: [],
      completedAt: daysAgo(randInt(0, 21))
    });
  }
  return sessions;
}

function buildStudent(globalIndex: number, a: Archetype, pool: SubAcquisRef[], classId: string) {
  const identifier = `${STUDENT_PREFIX}${String(globalIndex + 1).padStart(3, "0")}`;
  const fullName = `${FIRST_NAMES[globalIndex % FIRST_NAMES.length]} ${LAST_NAMES[globalIndex % LAST_NAMES.length]}`;
  const email = `${identifier}@nextlearn-demo.tn`;

  const weeks = randInt(4, 16);
  const createdAt = daysAgo(weeks * 7);

  const numCompleted = clamp(Math.round(pick(a.completionRange) * pool.length), 1, pool.length);
  const completed = shuffle(pool).slice(0, numCompleted);
  const withQuiz = completed.slice(0, Math.max(1, Math.round(completed.length * pick(a.quizCoverageRange))));

  const quizResults = withQuiz.flatMap((item) => generateQuizSubmissions(item, a, createdAt));
  const finalScores = withQuiz.map((item) => {
    const forItem = quizResults.filter((q) => q.moduleId === item.moduleId && q.subAcquisId === item.subAcquisId);
    return forItem[forItem.length - 1].score;
  });

  const loginCount = Math.max(0, Math.round(pick(a.loginsPerWeekRange) * weeks));
  const lastLoginDate = daysAgo(randInt(a.lastLoginRecencyDaysRange[0], a.lastLoginRecencyDaysRange[1]));
  const averageQuizGrade = finalScores.length ? Math.round(finalScores.reduce((s, v) => s + v, 0) / finalScores.length) : 0;
  const xp = numCompleted * 10 + quizResults.length * 5;

  const attentionSessions = generateAttentionSessions(identifier, a, pool);
  const avgFocusScore = attentionSessions.length
    ? Math.round(attentionSessions.reduce((s, v) => s + v.avgFocusScore, 0) / attentionSessions.length)
    : null;

  const userDoc = {
    fullName, identifier, email, password: DEMO_PASSWORD, createdAt,
    progress: {
      xp,
      completedLessonKeys: completed.map((i) => `${i.moduleId}::${i.subAcquisId}`),
      quizResults: quizResults.map((q) => ({
        lessonKey: `${q.moduleId}::${q.subAcquisId}`, moduleId: q.moduleId, subAcquisId: q.subAcquisId,
        score: Math.round(q.score), submittedAt: q.submittedAt
      })),
      attentionSessions,
      avgFocusScore
    }
  };
  const profileDoc = {
    fullName, identifier, email, classId,
    lessonsCompleted: numCompleted, quizzesTaken: withQuiz.length, averageQuizGrade,
    xp, loginCount, lastLoginDate, createdAt
  };
  return { userDoc, profileDoc };
}

async function main(): Promise<void> {
  if (!env.mongodbUri) throw new Error("MONGODB_URI is not set");
  await mongoose.connect(env.mongodbUri);

  const pool = await resolveSubAcquisPool();
  if (pool.length === 0) {
    throw new Error("Aucun sous-acquis trouvé — seedez d'abord le curriculum (npm run seed:modules).");
  }

  const teachers = await resolveTeachers();

  // Idempotent: remove this script's own demo students before recreating them.
  await User.deleteMany({ identifier: { $regex: `^${STUDENT_PREFIX}` } });
  await StudentProfile.deleteMany({ identifier: { $regex: `^${STUDENT_PREFIX}` } });

  let globalIndex = 0;
  const summary: Array<{ className: string; teacher: string; count: number }> = [];

  for (const cls of CLASSES) {
    const teacher = teachers[cls.teacher];
    const classId = await resolveClass(cls.name, teacher.id, teacher.name);

    const built = [];
    for (const key of Object.keys(cls.mix) as ArchetypeKey[]) {
      for (let i = 0; i < (cls.mix as any)[key]; i++) {
        built.push(buildStudent(globalIndex, ARCHETYPES[key], pool, classId));
        globalIndex++;
      }
    }

    const createdUsers = await User.create(built.map((b) => b.userDoc));
    await StudentProfile.create(built.map((b) => b.profileDoc));
    // Force-backdate createdAt so login-frequency features use a realistic account age.
    await User.bulkWrite(built.map((b, i) => ({
      updateOne: { filter: { _id: createdUsers[i]._id }, update: { $set: { createdAt: b.userDoc.createdAt } } }
    })));
    await StudentProfile.bulkWrite(built.map((b) => ({
      updateOne: { filter: { identifier: b.profileDoc.identifier }, update: { $set: { createdAt: b.profileDoc.createdAt } } }
    })));

    summary.push({ className: cls.name, teacher: teacher.name, count: built.length });
  }

  const adminExists = await Teacher.exists({ role: "admin" });

  console.log(`\nCurriculum: ${pool.length} sous-acquis disponibles.`);
  console.log(`\nEnseignants:`);
  for (const t of teachers) console.log(`  - ${t.name} <${t.email}>${t.created ? ` (créé · mot de passe: ${DEMO_PASSWORD})` : " (existant)"}`);
  console.log(`\nClasses remplies (${globalIndex} étudiants au total):`);
  for (const s of summary) console.log(`  - ${s.className} — ${s.count} étudiants — enseignant ${s.teacher}`);
  console.log(`\nMot de passe (comptes étudiants démo): ${DEMO_PASSWORD}`);
  console.log(adminExists
    ? `\nUn compte admin existe déjà : connectez-vous en admin pour voir toutes les classes et enseignants.`
    : `\nAucun compte admin trouvé. Créez-en un (rôle "admin") pour voir la vue globale, ou connectez-vous comme enseignant.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await mongoose.disconnect().catch(() => undefined); });
