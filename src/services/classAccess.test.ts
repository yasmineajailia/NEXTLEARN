/**
 * Tests for the calendar/access-control logic in classAccess.ts.
 *
 * This is the exact code class responsible for two real production bugs this
 * project shipped: isSubAcquisAccessibleByAccessRules failing open when the
 * routes that call it forgot requireAuth (content unlocked for everyone,
 * always), and filterOverviewByAccess dropping modules that were merely empty
 * (never had content) as if they were fully calendar-locked. Both are pinned
 * down here so they can't silently regress.
 */
import { describe, it, expect } from "vitest";
import {
  isSubAcquisAccessibleByAccessRules,
  filterOverviewByAccess,
  parseCalendarWeekMap,
  buildScheduleBySubAcquis,
  encodeScheduleStorageKey,
  decodeScheduleStorageKey,
  toStudentCalendarEntries,
  isModuleBlocked,
  isSubAcquisUnlocked,
  hasScheduledUnlock,
  isOwnedByCaller
} from "./classAccess";
import type { ClassAccessContext, ModuleOverview } from "../types/curriculum";

function makeAccess(overrides: Partial<ClassAccessContext> = {}): ClassAccessContext {
  return {
    classId: "class-1",
    accessByModule: {},
    scheduleStartDate: null,
    accessScheduleBySubAcquis: {},
    ...overrides
  };
}

const HOUR_MS = 60 * 60 * 1000;
const past = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR_MS).toISOString();
const future = (hoursAhead: number) => new Date(Date.now() + hoursAhead * HOUR_MS).toISOString();

describe("isSubAcquisAccessibleByAccessRules", () => {
  it("fails open (accessible) when there is no access context at all", () => {
    expect(isSubAcquisAccessibleByAccessRules(null, "programmation-c", "1.1")).toBe(true);
  });

  it("is accessible once the scheduled unlock date has passed", () => {
    const access = makeAccess({ accessScheduleBySubAcquis: { "1.1": past(1) } });
    expect(isSubAcquisAccessibleByAccessRules(access, "programmation-c", "1.1")).toBe(true);
  });

  it("is NOT accessible when the scheduled unlock date is still in the future", () => {
    const access = makeAccess({ accessScheduleBySubAcquis: { "4.1": future(1) } });
    expect(isSubAcquisAccessibleByAccessRules(access, "programmation-c", "4.1")).toBe(false);
  });

  it("falls back to the module-block flag when there is no schedule entry at all", () => {
    const blocked = makeAccess({ accessByModule: { "programmation-c": "blocked" } });
    expect(isSubAcquisAccessibleByAccessRules(blocked, "programmation-c", "9.9")).toBe(false);

    const open = makeAccess({ accessByModule: { "programmation-c": "granted" } });
    expect(isSubAcquisAccessibleByAccessRules(open, "programmation-c", "9.9")).toBe(true);
  });

  it("no accessByModule entry at all defaults to accessible (matches the platform's real curriculum, whose single module id never appears in the legacy per-chapter accessByModule keys)", () => {
    const access = makeAccess({ accessByModule: {} });
    expect(isSubAcquisAccessibleByAccessRules(access, "programmation-c", "2.2")).toBe(true);
  });

  it("a scheduled unlock date is authoritative even when the module is also flagged blocked", () => {
    const access = makeAccess({
      accessByModule: { "programmation-c": "blocked" },
      accessScheduleBySubAcquis: { "1.1": past(1) }
    });
    expect(isSubAcquisAccessibleByAccessRules(access, "programmation-c", "1.1")).toBe(true);
  });
});

describe("isModuleBlocked / isSubAcquisUnlocked / hasScheduledUnlock", () => {
  it("isModuleBlocked is case-insensitive and defaults to not-blocked", () => {
    expect(isModuleBlocked({ m: "BLOCKED" }, "m")).toBe(true);
    expect(isModuleBlocked({ m: "granted" }, "m")).toBe(false);
    expect(isModuleBlocked({}, "m")).toBe(false);
  });

  it("isSubAcquisUnlocked treats a missing or malformed date as unlocked", () => {
    expect(isSubAcquisUnlocked({}, "1.1")).toBe(true);
    expect(isSubAcquisUnlocked({ "1.1": "not-a-date" }, "1.1")).toBe(true);
  });

  it("hasScheduledUnlock reflects whether a schedule entry exists at all", () => {
    expect(hasScheduledUnlock({ "1.1": past(1) }, "1.1")).toBe(true);
    expect(hasScheduledUnlock({}, "1.1")).toBe(false);
  });
});

describe("isOwnedByCaller", () => {
  // Real bug this pins down: PUT/DELETE /api/backoffice/students/:id and the
  // class access/schedule/teacher-management routes let ANY teacher act on
  // ANY other teacher's class or student before this check existed.
  it("an admin may act on any resource regardless of who owns it", () => {
    expect(isOwnedByCaller("teacher-A", { id: "teacher-B", role: "admin" })).toBe(true);
    expect(isOwnedByCaller(undefined, { id: "teacher-B", role: "admin" })).toBe(true);
  });

  it("a teacher may act on their own resource", () => {
    expect(isOwnedByCaller("teacher-A", { id: "teacher-A", role: "enseignant" })).toBe(true);
  });

  it("a teacher may NOT act on another teacher's resource", () => {
    expect(isOwnedByCaller("teacher-A", { id: "teacher-B", role: "enseignant" })).toBe(false);
  });

  it("denies by default when there is no caller identity at all", () => {
    expect(isOwnedByCaller("teacher-A", null)).toBe(false);
    expect(isOwnedByCaller("teacher-A", undefined)).toBe(false);
  });

  it("denies when the resource has no owner on record (never matches an empty caller id)", () => {
    expect(isOwnedByCaller(null, { id: "", role: "enseignant" })).toBe(false);
    expect(isOwnedByCaller(undefined, { id: "", role: "enseignant" })).toBe(false);
  });

  it("compares the Mongoose ObjectId's string form, not object identity", () => {
    const objectIdLike = { toString: () => "teacher-A" };
    expect(isOwnedByCaller(objectIdLike, { id: "teacher-A", role: "enseignant" })).toBe(true);
  });
});

describe("filterOverviewByAccess", () => {
  const overview: ModuleOverview[] = [
    {
      id: "programmation-c",
      name: "Programmation en C",
      sortOrder: 0,
      subAcquisCount: 2,
      subAcquis: [
        { id: "1.1", name: "Intro", hasQuiz: true, hasVideo: false },
        { id: "4.1", name: "Tableaux", hasQuiz: true, hasVideo: false }
      ]
    },
    {
      id: "uiux",
      name: "UI/UX",
      sortOrder: 1,
      subAcquisCount: 0,
      subAcquis: []
    }
  ];

  it("returns everything unfiltered when there is no access context", () => {
    expect(filterOverviewByAccess(overview, null)).toEqual(overview);
  });

  it("keeps only the unlocked sous-acquis within a module that has a mix of locked/unlocked content", () => {
    const access = makeAccess({
      accessScheduleBySubAcquis: { "1.1": past(1), "4.1": future(1) }
    });
    const [pc] = filterOverviewByAccess(overview, access);
    expect(pc.subAcquis.map((s) => s.id)).toEqual(["1.1"]);
    expect(pc.subAcquisCount).toBe(1);
  });

  it("drops a module entirely once EVERY sous-acquis it used to show is now locked", () => {
    const access = makeAccess({
      accessScheduleBySubAcquis: { "1.1": future(1), "4.1": future(1) }
    });
    const filtered = filterOverviewByAccess(overview, access);
    expect(filtered.find((m) => m.id === "programmation-c")).toBeUndefined();
  });

  it("regression: a module that never had any content (empty from the start) still shows up, instead of being swept out by the same rule that hides fully-locked modules", () => {
    const access = makeAccess({
      accessScheduleBySubAcquis: { "1.1": past(1), "4.1": past(1) }
    });
    const filtered = filterOverviewByAccess(overview, access);
    const uiux = filtered.find((m) => m.id === "uiux");
    expect(uiux).toBeDefined();
    expect(uiux?.subAcquis).toEqual([]);
  });
});

describe("parseCalendarWeekMap", () => {
  it("parses well-formed 'X.Y : semaine N' lines", () => {
    const map = parseCalendarWeekMap("1.1 : semaine 1\n1.2 : semaine 1\n2.1 : semaine 2");
    expect(map).toEqual({ "1.1": 1, "1.2": 1, "2.1": 2 });
  });

  it("tolerates extra whitespace and blank lines", () => {
    const map = parseCalendarWeekMap("  4.8 : semaine 5 \n\n\n4.9 :semaine 5\n");
    expect(map).toEqual({ "4.8": 5, "4.9": 5 });
  });

  it("ignores malformed or unrecognized lines instead of throwing", () => {
    const map = parseCalendarWeekMap("not a calendar line\n1.1 : week 1\n1.2 : semaine 1");
    expect(map).toEqual({ "1.2": 1 });
  });

  it("returns an empty map for empty input", () => {
    expect(parseCalendarWeekMap("")).toEqual({});
  });
});

describe("buildScheduleBySubAcquis", () => {
  const overview: ModuleOverview[] = [
    {
      id: "programmation-c",
      name: "Programmation en C",
      sortOrder: 0,
      subAcquisCount: 3,
      subAcquis: [
        { id: "1.1", name: "a", hasQuiz: false, hasVideo: false },
        { id: "2.1", name: "b", hasQuiz: false, hasVideo: false },
        { id: "9.9", name: "not in calendar.txt", hasQuiz: false, hasVideo: false }
      ]
    }
  ];
  const startDate = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01

  it("week 1 unlocks exactly on the start date", () => {
    const schedule = buildScheduleBySubAcquis({ overview, weekMap: { "1.1": 1 }, startDate });
    expect(schedule["1.1"]).toBe(startDate.toISOString());
  });

  it("week N unlocks (N-1)*7 days after the start date", () => {
    const schedule = buildScheduleBySubAcquis({ overview, weekMap: { "2.1": 3 }, startDate });
    const expected = new Date(startDate.getTime() + 2 * 7 * 24 * 60 * 60 * 1000);
    expect(schedule["2.1"]).toBe(expected.toISOString());
  });

  it("a sous-acquis missing from calendar.txt defaults to week 1 rather than being left unscheduled", () => {
    const schedule = buildScheduleBySubAcquis({ overview, weekMap: { "1.1": 1 }, startDate });
    expect(schedule["9.9"]).toBe(startDate.toISOString());
  });
});

describe("encodeScheduleStorageKey / decodeScheduleStorageKey", () => {
  it("round-trips ids containing dots (Mongoose Map keys can't contain '.')", () => {
    const id = "4.9";
    expect(decodeScheduleStorageKey(encodeScheduleStorageKey(id))).toBe(id);
  });

  it("encoding actually removes the dot so it's Map-key-safe", () => {
    expect(encodeScheduleStorageKey("4.9")).not.toContain(".");
  });
});

describe("toStudentCalendarEntries", () => {
  const overview: ModuleOverview[] = [
    {
      id: "programmation-c",
      name: "Programmation en C",
      sortOrder: 0,
      subAcquisCount: 2,
      subAcquis: [
        { id: "2.1", name: "later", hasQuiz: false, hasVideo: false },
        { id: "1.1", name: "earlier", hasQuiz: false, hasVideo: false }
      ]
    }
  ];

  it("sorts entries by unlock date ascending regardless of curriculum order", () => {
    const access = makeAccess({
      accessScheduleBySubAcquis: { "2.1": future(10), "1.1": future(1) }
    });
    const entries = toStudentCalendarEntries(overview, access);
    expect(entries.map((e) => e.subAcquisId)).toEqual(["1.1", "2.1"]);
  });

  it("marks each entry's unlocked flag consistently with isSubAcquisAccessibleByAccessRules", () => {
    const access = makeAccess({
      accessScheduleBySubAcquis: { "1.1": past(1), "2.1": future(1) }
    });
    const entries = toStudentCalendarEntries(overview, access);
    expect(entries.find((e) => e.subAcquisId === "1.1")?.unlocked).toBe(true);
    expect(entries.find((e) => e.subAcquisId === "2.1")?.unlocked).toBe(false);
  });
});
