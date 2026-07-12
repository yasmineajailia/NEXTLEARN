/**
 * Shared curriculum / class-access shapes used by the web routes and the
 * services extracted from them.
 */
export type SubAcquisOverview = {
  id: string;
  name: string;
  hasQuiz: boolean;
  hasVideo: boolean;
};

export type ModuleOverview = {
  id: string;
  name: string;
  sortOrder: number;
  subAcquisCount: number;
  subAcquis: SubAcquisOverview[];
};

export type ClassAccessContext = {
  classId: string;
  accessByModule: Record<string, string>;
  scheduleStartDate: string | null;
  accessScheduleBySubAcquis: Record<string, string>;
};

export type StudentCalendarEntry = {
  moduleId: string;
  moduleName: string;
  subAcquisId: string;
  subAcquisName: string;
  unlockAt: string | null;
  unlocked: boolean;
};

