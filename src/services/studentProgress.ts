/**
 * Pure helpers over a student's raw progress data (completed lessons and
 * quiz results). Shared by the student dashboard, predictions and the
 * back-office organization view.
 */
export function buildLessonKey(moduleId: string, subAcquisId: string): string {
  return `${moduleId}::${subAcquisId}`;
}

export function computeModuleQuizScores(quizResults: unknown): Record<string, number> {
  if (!Array.isArray(quizResults)) return {};
  const byModule: Record<string, { total: number; count: number }> = {};
  for (const entry of quizResults) {
    const mid = String((entry as any)?.moduleId || "").trim();
    const score = Number((entry as any)?.score);
    if (!mid || !Number.isFinite(score)) continue;
    if (!byModule[mid]) byModule[mid] = { total: 0, count: 0 };
    byModule[mid].total += score;
    byModule[mid].count += 1;
  }
  const out: Record<string, number> = {};
  for (const [mid, { total, count }] of Object.entries(byModule)) {
    out[mid] = Math.round((total / count / 5) * 10) / 10; // percentage → /20
  }
  return out;
}

export function computeStudentProgress(progress: unknown): {
  lessonsCompleted: number;
  quizzesPassed: number;
  averageQuizScoreOn20: number;
} {
  const progressRecord = (progress ?? {}) as {
    completedLessonKeys?: unknown;
    quizResults?: Array<{ score?: unknown }>;
  };

  const completedLessonKeys = Array.isArray(progressRecord.completedLessonKeys)
    ? progressRecord.completedLessonKeys.filter((entry): entry is string => typeof entry === "string")
    : [];

  const quizResults = Array.isArray(progressRecord.quizResults)
    ? progressRecord.quizResults
        .map((entry) => {
          const score = Number(entry?.score);
          return Number.isFinite(score) ? score : NaN;
        })
        .filter((score) => Number.isFinite(score))
    : [];

  const averagePercent =
    quizResults.length > 0 ? quizResults.reduce((sum, score) => sum + score, 0) / quizResults.length : 0;

  return {
    lessonsCompleted: completedLessonKeys.length,
    quizzesPassed: quizResults.length,
    averageQuizScoreOn20: Math.round((averagePercent / 5) * 10) / 10
  };
}
