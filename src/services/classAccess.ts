/**
 * Class access rules and unlock scheduling.
 *
 * A class carries per-module access rules ("blocked"/"open") and an optional
 * per-sub-acquis unlock schedule derived from data/calendar.txt week numbers
 * anchored on the class start date. These helpers convert the persisted
 * Mongoose shapes into plain records and evaluate the rules.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ClassAccessContext, ModuleOverview, StudentCalendarEntry } from "../types/curriculum";

export const SCHEDULE_KEY_DOT_TOKEN = "__dot__";

export function encodeScheduleStorageKey(subAcquisId: string): string {
  return String(subAcquisId || "").replace(/\./g, SCHEDULE_KEY_DOT_TOKEN);
}

export function decodeScheduleStorageKey(storedKey: string): string {
  return String(storedKey || "").replace(new RegExp(SCHEDULE_KEY_DOT_TOKEN, "g"), ".");
}

export function toAccessRecord(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }

  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value.entries()).map(([key, rule]) => [String(key), String(rule)]));
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, rule]) => {
      acc[String(key)] = String(rule || "");
      return acc;
    }, {});
  }

  return {};
}

export function toDateIsoRecord(value: unknown): Record<string, string> {
  if (!value) {
    return {};
  }

  const collectEntries = value instanceof Map
    ? Array.from(value.entries())
    : typeof value === "object"
      ? Object.entries(value as Record<string, unknown>)
      : [];

  return collectEntries.reduce<Record<string, string>>((acc, [rawKey, rawValue]) => {
    const key = String(rawKey || "").trim();
    if (!key) {
      return acc;
    }

    const date = rawValue instanceof Date ? rawValue : new Date(String(rawValue || ""));
    if (Number.isNaN(date.getTime())) {
      return acc;
    }

    acc[key] = date.toISOString();
    return acc;
  }, {});
}

export function toScheduleIsoRecord(value: unknown): Record<string, string> {
  const rawRecord = toDateIsoRecord(value);
  return Object.entries(rawRecord).reduce<Record<string, string>>((acc, [storedKey, isoValue]) => {
    acc[decodeScheduleStorageKey(storedKey)] = isoValue;
    return acc;
  }, {});
}

export function toIsoDateOrNull(value: unknown): string | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

/**
 * Whether `caller` may act on a class-owned resource: an admin always can;
 * otherwise only the teacher recorded as that resource's owner. The
 * `/api/backoffice` router-level guard only proves the caller is SOME
 * teacher/admin — this is the check that scopes it to the RIGHT teacher.
 * Was previously duplicated inline (with the polarity inverted) across
 * attention.ts, vark.ts, clustering.ts, and organization.ts; centralized here
 * so it's tested once instead of trusted seven times.
 */
export function isOwnedByCaller(
  resourceTeacherId: unknown,
  auth: { id: string; role: string } | null | undefined
): boolean {
  if (auth?.role === "admin") {
    return true;
  }
  const callerId = auth?.id ?? "";
  // Fail closed: an empty caller id must never "match" a resource with no
  // owner on record just because both sides stringify to "" (in practice
  // requireAuth/requireRole never set req.auth.id to "", but this check
  // shouldn't depend on that holding true elsewhere).
  if (!callerId) {
    return false;
  }
  return String(resourceTeacherId || "") === callerId;
}

export function isModuleBlocked(accessByModule: Record<string, string>, moduleId: string): boolean {
  return String(accessByModule[moduleId] || "").toLowerCase() === "blocked";
}

export function isSubAcquisUnlocked(accessScheduleBySubAcquis: Record<string, string>, subAcquisId: string): boolean {
  const unlockAt = String(accessScheduleBySubAcquis[subAcquisId] || "").trim();
  if (!unlockAt) {
    return true;
  }

  const unlockDate = new Date(unlockAt);
  if (Number.isNaN(unlockDate.getTime())) {
    return true;
  }

  return unlockDate.getTime() <= Date.now();
}

export function hasScheduledUnlock(accessScheduleBySubAcquis: Record<string, string>, subAcquisId: string): boolean {
  return Boolean(String(accessScheduleBySubAcquis[subAcquisId] || "").trim());
}

export function isSubAcquisAccessibleByAccessRules(
  access: ClassAccessContext | null,
  moduleId: string,
  subAcquisId: string
): boolean {
  if (!access) {
    return true;
  }

  const moduleBlocked = isModuleBlocked(access.accessByModule, moduleId);
  const scheduled = hasScheduledUnlock(access.accessScheduleBySubAcquis, subAcquisId);

  // When a schedule exists, the unlock date is authoritative for students.
  if (scheduled) {
    return isSubAcquisUnlocked(access.accessScheduleBySubAcquis, subAcquisId);
  }

  return !moduleBlocked;
}

export function parseCalendarWeekMap(text: string): Record<string, number> {
  const mapping: Record<string, number> = {};

  const normalizeCalendarSubAcquisId = (rawValue: string): string => {
    const compact = String(rawValue || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/\.$/, "");
    const match = compact.match(/^(\d+)\.(\d+)$/);
    return match ? `${match[1]}.${match[2]}` : compact;
  };

  String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const match = line.match(/^(\d+\.\d+)\s*:\s*semaine\s*(\d+)\s*$/i);
      if (!match) {
        return;
      }

      const subAcquisId = normalizeCalendarSubAcquisId(String(match[1] || ""));
      const weekNumber = Number(match[2]);
      if (!subAcquisId || !Number.isFinite(weekNumber) || weekNumber < 1) {
        return;
      }

      mapping[subAcquisId] = weekNumber;
    });

  return mapping;
}

export async function readCalendarWeekMapFromFile(): Promise<Record<string, number>> {
  try {
    const calendarPath = path.join(process.cwd(), "data", "calendar.txt");
    const raw = await fs.readFile(calendarPath, "utf8");
    return parseCalendarWeekMap(raw);
  } catch (_error) {
    return {};
  }
}

export function parseStartDateInput(rawValue: string): Date | null {
  const value = String(rawValue || "").trim();
  if (!value) {
    return null;
  }

  const ymdMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const month = Number(ymdMatch[2]) - 1;
    const day = Number(ymdMatch[3]);
    const utcDate = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
    return Number.isNaN(utcDate.getTime()) ? null : utcDate;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate(), 0, 0, 0, 0));
}

export function buildScheduleBySubAcquis(params: {
  overview: ModuleOverview[];
  weekMap: Record<string, number>;
  startDate: Date;
}): Record<string, string> {
  const { overview, weekMap, startDate } = params;
  const schedule: Record<string, string> = {};

  const normalizeCalendarSubAcquisId = (rawValue: string): string => {
    const compact = String(rawValue || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/\.$/, "");
    const match = compact.match(/^(\d+)\.(\d+)$/);
    return match ? `${match[1]}.${match[2]}` : compact;
  };

  overview.forEach((moduleData) => {
    moduleData.subAcquis.forEach((subAcquis) => {
      const normalizedSubAcquisId = normalizeCalendarSubAcquisId(subAcquis.id);
      const weekNumber = Number(weekMap[normalizedSubAcquisId] || weekMap[subAcquis.id] || 1);
      const safeWeek = Number.isFinite(weekNumber) && weekNumber > 0 ? weekNumber : 1;
      const unlockDate = new Date(startDate.getTime() + (safeWeek - 1) * 7 * 24 * 60 * 60 * 1000);
      schedule[subAcquis.id] = unlockDate.toISOString();
    });
  });

  return schedule;
}

export function filterOverviewByAccess(overview: ModuleOverview[], access: ClassAccessContext | null): ModuleOverview[] {
  if (!access) {
    return overview;
  }

  return overview
    .map((moduleData) => {
      const filteredSubAcquis = moduleData.subAcquis.filter((entry) =>
        isSubAcquisAccessibleByAccessRules(access, moduleData.id, entry.id)
      );

      // A module that never had any content (no lessons added yet) should still
      // show as an empty placeholder — only drop a module when the calendar hid
      // everything that USED to be there, not when there was nothing to begin with.
      if (moduleData.subAcquis.length > 0 && !filteredSubAcquis.length) {
        return null;
      }

      return {
        ...moduleData,
        subAcquisCount: filteredSubAcquis.length,
        subAcquis: filteredSubAcquis
      };
    })
    .filter((moduleData): moduleData is ModuleOverview => Boolean(moduleData));
}

export function toStudentCalendarEntries(overview: ModuleOverview[], access: ClassAccessContext | null): StudentCalendarEntry[] {
  const entries = overview.flatMap((moduleData) => {
    return moduleData.subAcquis.map((subAcquis) => {
      const unlockAt = access ? access.accessScheduleBySubAcquis[subAcquis.id] || null : null;
      const accessible = isSubAcquisAccessibleByAccessRules(access, moduleData.id, subAcquis.id);

      return {
        moduleId: moduleData.id,
        moduleName: moduleData.name,
        subAcquisId: subAcquis.id,
        subAcquisName: subAcquis.name,
        unlockAt,
        unlocked: accessible
      };
    });
  });

  return entries.sort((a, b) => {
    const aDate = a.unlockAt ? new Date(a.unlockAt).getTime() : 0;
    const bDate = b.unlockAt ? new Date(b.unlockAt).getTime() : 0;
    return aDate - bDate;
  });
}

