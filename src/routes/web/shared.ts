/**
 * routes/web/shared.ts
 *
 * Thin barrel + a couple of small, genuinely cross-cutting helpers for the
 * web route modules. The bulk of the former 1946-line version of this file
 * has been split by domain into:
 *   - curriculumContent.ts  — curriculum persistence, filesystem seeding,
 *     media/course-file resolution, quiz text parsing (DOCX/JSON).
 *   - assessmentState.ts    — recommendation-graph cache, teacher
 *     quiz-generation sessions, remediation-quiz attempt state,
 *     self-evaluation scoring.
 * Both are re-exported here so every existing `import { X } from "./shared.js"`
 * across the route modules keeps working unchanged.
 *
 * Only `webRouter` (in web.ts) is a public contract; everything here is
 * internal to the route layer.
 */
import { ClassRoom } from "../../models/ClassRoom";
import { StudentProfile } from "../../models/StudentProfile";
import {
  buildScheduleBySubAcquis,
  parseStartDateInput,
  readCalendarWeekMapFromFile,
  toAccessRecord,
  toIsoDateOrNull,
  toScheduleIsoRecord
} from "../../services/classAccess";
import type { ClassAccessContext } from "../../types/curriculum";
import { readPersistedProgramCOverview } from "./curriculumContent";

export async function readClassAccessByStudentIdentifier(identifier: string): Promise<ClassAccessContext | null> {
  const normalizedIdentifier = String(identifier || "").trim();
  if (!normalizedIdentifier) {
    return null;
  }

  const student = await StudentProfile.findOne({ identifier: normalizedIdentifier })
    .select({ classId: 1 })
    .lean();

  if (!student?.classId) {
    return null;
  }

  const classRoom = await ClassRoom.findById(student.classId)
    .select({ _id: 1, accessByModule: 1, scheduleStartDate: 1, accessScheduleBySubAcquis: 1 })
    .lean();

  if (!classRoom) {
    return null;
  }

  const scheduleStartDate = toIsoDateOrNull((classRoom as any).scheduleStartDate);
  let resolvedScheduleBySubAcquis = toScheduleIsoRecord((classRoom as any).accessScheduleBySubAcquis);

  // Keep scheduling aligned with calendar.txt even if persisted schedule snapshots are outdated.
  if (scheduleStartDate) {
    const parsedStartDate = parseStartDateInput(scheduleStartDate);
    if (parsedStartDate) {
      try {
        const [overview, weekMap] = await Promise.all([
          readPersistedProgramCOverview(),
          readCalendarWeekMapFromFile()
        ]);

        resolvedScheduleBySubAcquis = buildScheduleBySubAcquis({
          overview,
          weekMap,
          startDate: parsedStartDate
        });
      } catch (_error) {
        // Fallback to persisted schedule if recomputation fails.
      }
    }
  }

  return {
    classId: String((classRoom as any)._id || ""),
    accessByModule: toAccessRecord((classRoom as any).accessByModule),
    scheduleStartDate,
    accessScheduleBySubAcquis: resolvedScheduleBySubAcquis
  };
}

export * from "./curriculumContent";
export * from "./assessmentState";
