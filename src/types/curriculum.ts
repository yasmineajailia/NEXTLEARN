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

/* Curriculum data shapes persisted in Mongo (see models/CurriculumModule). */
export type QuizQuestion = {
  prompt: string;
  options: string[];
  correctOptionIndex: number | null;
  /**
   * The sous-acquis this question primarily tests (e.g. "1.2"), used to steer
   * response-based remediation: a wrong answer points the student at this concept.
   * Optional — populated at quiz-generation time; absent for legacy questions,
   * which fall back to the failed sous-acquis's prerequisites.
   */
  relatedSubAcquis?: string | null;
};

export type QuizJsonPayload = {
  questions?: Array<{
    prompt?: string;
    options?: string[];
    correctOptionIndex?: number | null;
  }>;
};

export type CurriculumQuizQuestion = {
  prompt: string;
  options: string[];
  correctAnswerIndex: number | null;
};

export type CurriculumQuiz = {
  id: string;
  type: string;
  title: string;
  questions: CurriculumQuizQuestion[];
};

export type CurriculumCourseFile = {
  id: string;
  title: string;
  url: string;
  fileType: string;
};

export type CurriculumVideo = {
  id: string;
  title: string;
  url: string;
  source: string;
};

export type CurriculumSubAcquis = {
  id: string;
  name: string;
  bloomLevel?: string;
  resource?: {
    type?: string;
    ref?: string;
  };
  lessonsCount?: number;
  courseFiles?: CurriculumCourseFile[];
  videos?: CurriculumVideo[];
  quizzes?: CurriculumQuiz[];
};

export type CurriculumAcquis = {
  id: string;
  name: string;
  isDefaultBucket?: boolean;
  sousAcquis: CurriculumSubAcquis[];
};

export type CurriculumModuleDoc = {
  id: string;
  name: string;
  sortOrder?: number;
  acquis: CurriculumAcquis[];
};

