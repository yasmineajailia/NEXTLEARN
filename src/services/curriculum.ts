/**
 * Curriculum shape mapping. Seed of the future curriculum service — the
 * read/seed/persist machinery still lives in routes/web.ts.
 */
import type { CurriculumModuleDoc } from "../types/curriculum";

export function moduleDocToOverview(moduleDoc: CurriculumModuleDoc): {
  id: string;
  name: string;
  sortOrder: number;
  subAcquisCount: number;
  subAcquis: Array<{ id: string; name: string; hasQuiz: boolean; hasVideo: boolean }>;
} {
  const subAcquis = moduleDoc.acquis.flatMap((acquis) =>
    acquis.sousAcquis.map((entry) => ({
      id: entry.id,
      name: entry.name || entry.id,
      hasQuiz: Array.isArray(entry.quizzes) && entry.quizzes.length > 0,
      hasVideo:
        (Array.isArray(entry.videos) && entry.videos.length > 0) ||
        Boolean(entry.resource?.ref)
    }))
  );

  return {
    id: moduleDoc.id,
    name: moduleDoc.name || moduleDoc.id,
    sortOrder: Number.isFinite(Number(moduleDoc.sortOrder)) ? Number(moduleDoc.sortOrder) : 0,
    subAcquisCount: subAcquis.length,
    subAcquis
  };
}
