const STORAGE_KEY = "nextlearn_backoffice_data_v1";

/** French stays inline as the fallback; English comes from the i18n dictionary. */
const boTr = (key, fr) => (window.I18N ? window.I18N.t(key, fr) : fr);

const initialData = {
  teachers: [
    { id: "tch-1", name: "Pr. Sami", email: "sami@nextlearn.tn", phone: "+21620000001" },
    { id: "tch-2", name: "Pr. Amel", email: "amel@nextlearn.tn", phone: "+21620000002" },
    { id: "tch-3", name: "Pr. Karim", email: "karim@nextlearn.tn", phone: "+21620000003" },
    { id: "tch-4", name: "Pr. Mouna", email: "mouna@nextlearn.tn", phone: "+21620000004" }
  ],
  modules: [
    {
      id: "mod-1",
      name: "Bases du langage C",
      acquis: [
        {
          id: "acq-1",
          name: "Structures de controle",
          sousAcquis: [
            {
              id: "sacq-1",
              name: "Boucles",
              lessonsCount: 4,
              quizzes: [
                {
                  id: "quiz-1",
                  title: "Verification des boucles",
                  questions: [
                    {
                      prompt: "Quelle boucle s'execute au moins une fois ?",
                      options: ["for", "while", "do while", "foreach"],
                      correctAnswerIndex: 2
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    },
    {
      id: "mod-2",
      name: "Pointeurs",
      acquis: [
        {
          id: "acq-2",
          name: "Arithmetique des pointeurs",
          sousAcquis: [
            {
              id: "sacq-2",
              name: "Adresses memoire",
              lessonsCount: 3,
              quizzes: []
            }
          ]
        }
      ]
    }
  ],
  classes: [
    {
      id: "class-1",
      name: "INFO-2A",
      teacherName: "Pr. Sami",
      accessByModule: {
        "mod-1": "granted",
        "mod-2": "blocked"
      }
    },
    {
      id: "class-2",
      name: "INFO-2B",
      teacherName: "Pr. Amel",
      accessByModule: {
        "mod-1": "granted",
        "mod-2": "granted"
      }
    },
    {
      id: "class-3",
      name: "INFO-1A",
      teacherName: "Pr. Karim",
      accessByModule: {
        "mod-1": "granted",
        "mod-2": "blocked"
      }
    },
    {
      id: "class-4",
      name: "GL-2A",
      teacherName: "Pr. Mouna",
      accessByModule: {
        "mod-1": "blocked",
        "mod-2": "granted"
      }
    }
  ],
  students: [
    {
      id: "stu-1",
      fullName: "Leila Ben Naceur",
      email: "leila@nextlearn.tn",
      classId: "class-1",
      lessonsCompleted: 6,
      quizzesTaken: 3,
      averageQuizGrade: 14.5
    },
    {
      id: "stu-2",
      fullName: "Hatem K.",
      email: "hatem@nextlearn.tn",
      classId: "class-1",
      lessonsCompleted: 4,
      quizzesTaken: 2,
      averageQuizGrade: 11.8
    },
    {
      id: "stu-3",
      fullName: "Nour Eddine M.",
      email: "nour@nextlearn.tn",
      classId: "class-2",
      lessonsCompleted: 8,
      quizzesTaken: 4,
      averageQuizGrade: 15.2
    },
    {
      id: "stu-4",
      fullName: "Salma Trabelsi",
      email: "salma@nextlearn.tn",
      classId: "class-2",
      lessonsCompleted: 7,
      quizzesTaken: 4,
      averageQuizGrade: 13.9
    },
    {
      id: "stu-5",
      fullName: "Yassine Ben Ali",
      email: "yassine@nextlearn.tn",
      classId: "class-2",
      lessonsCompleted: 5,
      quizzesTaken: 3,
      averageQuizGrade: 12.6
    },
    {
      id: "stu-6",
      fullName: "Rim G.",
      email: "rim@nextlearn.tn",
      classId: "class-3",
      lessonsCompleted: 3,
      quizzesTaken: 2,
      averageQuizGrade: 10.4
    },
    {
      id: "stu-7",
      fullName: "Mahdi Ferchichi",
      email: "mahdi@nextlearn.tn",
      classId: "class-3",
      lessonsCompleted: 6,
      quizzesTaken: 3,
      averageQuizGrade: 13.1
    },
    {
      id: "stu-8",
      fullName: "Lina Ch.",
      email: "lina@nextlearn.tn",
      classId: "class-4",
      lessonsCompleted: 9,
      quizzesTaken: 5,
      averageQuizGrade: 16.0
    },
    {
      id: "stu-9",
      fullName: "Omar Jaziri",
      email: "omar@nextlearn.tn",
      classId: "class-4",
      lessonsCompleted: 4,
      quizzesTaken: 2,
      averageQuizGrade: 11.2
    },
    {
      id: "stu-10",
      fullName: "Mariem B.",
      email: "mariem@nextlearn.tn",
      classId: "class-4",
      lessonsCompleted: 7,
      quizzesTaken: 4,
      averageQuizGrade: 14.7
    }
  ]
};

let state = loadState();
let draftQuestions = [];
let curriculumOverview = [];
let curriculumSyncEnabled = false;
let curriculumNames = {
  modulesById: {},
  subAcquisById: {}
};
let contentEditorState = {
  moduleId: "",
  subAcquisId: "",
  selectedAcquisId: ""
};
let moduleInsertState = {
  insertIndex: null
};
let subInsertState = {
  index: null,
  acquisId: ""
};
let acquisRenameState = {
  acquisId: ""
};
let acquisInsertState = {
  index: null
};
let pendingSubQuizDraft = createEmptyPendingSubQuiz();
const MIN_DYNAMIC_QUIZ_OPTIONS = 2;
let teacherEditState = {
  teacherId: ""
};
let studentEditState = {
  studentId: ""
};
let studentSearchTerm = "";
let selectedClassId = "";
let subEditorPendingDeleteIds = new Set();
let backofficeUser = null;

// Quiz Generator state

function createEmptyPendingSubQuiz() {
  return {
    title: "",
    type: "qcm",
    questions: []
  };
}

const dom = {
  navItems: Array.from(document.querySelectorAll(".nav-item")),
  views: {
    overview: document.getElementById("view-overview"),
    content: document.getElementById("view-content"),
    teachers: document.getElementById("view-teachers"),
    "classes-create": document.getElementById("view-classes-create"),
    "classes-access": document.getElementById("view-classes-access"),
    students: document.getElementById("view-students"),
    clustering: document.getElementById("view-clustering"),
    attention: document.getElementById("view-attention"),
    "classes-detail": document.getElementById("view-class-detail"),
    "sub-add": document.getElementById("view-sub-add"),
    "sub-editor": document.getElementById("view-sub-editor")
  },
  contentSwitchButtons: Array.from(document.querySelectorAll(".content-switch-btn")),
  contentPanels: {
    module: document.getElementById("content-panel-module"),
    "sous-acquis": document.getElementById("content-panel-sous-acquis"),
    quiz: document.getElementById("content-panel-quiz")
  },
  moduleIntroGrid: document.getElementById("module-intro-grid"),
  moduleManagementCard: document.getElementById("module-management-card"),
  studentsSwitchButtons: Array.from(document.querySelectorAll(".students-switch-btn")),
  studentsPanels: {
    "add-single": document.getElementById("students-panel-add-single"),
    "import-bulk": document.getElementById("students-panel-import-bulk")
  },
  panelEyebrow: document.getElementById("panel-eyebrow"),
  panelTitle: document.getElementById("panel-title"),
  toast: document.getElementById("toast"),
  sidebarUserName: document.getElementById("sidebar-user-name"),
  sidebarUserRole: document.getElementById("sidebar-user-role"),

  overviewClassFilter: document.getElementById("overview-class-filter"),
  overviewStudentFilter: document.getElementById("overview-student-filter"),
  kpiGrid: document.getElementById("kpi-grid"),
  atRiskList: document.getElementById("at-risk-list"),
  inactiveList: document.getElementById("inactive-list"),
  classGauges: document.getElementById("class-gauges"),
  quizStruggleList: document.getElementById("quiz-struggle-list"),
  moduleTableBody: document.getElementById("module-table-body"),

  moduleForm: document.getElementById("module-form"),
  sousAcquisForm: document.getElementById("sous-acquis-form"),
  sousModuleSelect: document.getElementById("sous-module-select"),
  contentTree: document.getElementById("content-tree"),

  quizForm: document.getElementById("quiz-form"),
  quizModuleSelect: document.getElementById("quiz-module-select"),
  quizSousAcquisSelect: document.getElementById("quiz-sous-acquis-select"),
  addQuestionBtn: document.getElementById("add-question-btn"),
  saveQuizBtn: document.getElementById("save-quiz-btn"),
  draftQuestions: document.getElementById("draft-questions"),
  contentManagementList: document.getElementById("content-management-list"),
  addModuleBtn: document.getElementById("add-module-btn"),
  moduleInsertPage: document.getElementById("module-insert-page"),
  moduleInsertTitle: document.getElementById("module-insert-title"),
  moduleInsertForm: document.getElementById("module-insert-form"),
  moduleInsertName: document.getElementById("module-insert-name"),
  moduleInsertCancel: document.getElementById("module-insert-cancel"),
  moduleInsertCancelBottom: document.getElementById("module-insert-cancel-bottom"),
  moduleEditorPage: document.getElementById("module-editor-page"),
  moduleEditorTitle: document.getElementById("module-editor-title"),
  moduleEditorClose: document.getElementById("module-editor-close"),
  moduleEditForm: document.getElementById("module-edit-form"),
  moduleEditName: document.getElementById("module-edit-name"),
  moduleDeleteBtn: document.getElementById("module-delete-btn"),
  moduleEditorSubList: document.getElementById("module-editor-sub-list"),
  moduleAddSubTitle: document.getElementById("module-add-sub-title"),
  moduleAddSubCancel: document.getElementById("module-add-sub-cancel"),
  moduleAddSubForm: document.getElementById("module-add-sub-form"),
  openSubQuizBuilderBtn: document.getElementById("open-sub-quiz-builder"),
  subQuizBuilderStatus: document.getElementById("sub-quiz-builder-status"),
  subQuizBuilderPage: document.getElementById("sub-quiz-builder-page"),
  subQuizBuilderBack: document.getElementById("sub-quiz-builder-back"),
  subQuizTitle: document.getElementById("sub-quiz-title"),
  subQuizType: document.getElementById("sub-quiz-type"),
  subQuizQuestion: document.getElementById("sub-quiz-question"),
  subQuizOptionsList: document.getElementById("sub-quiz-options-list"),
  subQuizAddOption: document.getElementById("sub-quiz-add-option"),
  subQuizCorrectAnswer: document.getElementById("sub-quiz-correct-answer"),
  subQuizAddQuestion: document.getElementById("sub-quiz-add-question"),
  subQuizClear: document.getElementById("sub-quiz-clear"),
  subQuizDraftList: document.getElementById("sub-quiz-draft-list"),
  subEditorTitle: document.getElementById("sub-editor-title"),
  subEditorBack: document.getElementById("sub-editor-back"),
  subEditForm: document.getElementById("sub-edit-form"),
  subEditName: document.getElementById("sub-edit-name"),
  subEditBloom: document.getElementById("sub-edit-bloom"),
  subEditLessons: document.getElementById("sub-edit-lessons"),
  subEditResourceFile: document.getElementById("sub-edit-resource-file"),
  subEditExistingFiles: document.getElementById("sub-edit-existing-files"),
  subEditVideoUrl: document.getElementById("sub-edit-video-url"),
  subEditQuizSelect: document.getElementById("sub-edit-quiz-select"),
  subEditQuizTitle: document.getElementById("sub-edit-quiz-title"),
  subEditQuizType: document.getElementById("sub-edit-quiz-type"),
  subEditQuizQuestions: document.getElementById("sub-edit-quiz-questions"),
  subEditDeleteBtn: document.getElementById("sub-edit-delete-btn"),
  manageModuleSelect: document.getElementById("manage-module-select"),
  manageAcquisSelect: document.getElementById("manage-acquis-select"),
  manageAcquisName: document.getElementById("manage-acquis-name"),
  renameAcquisBtn: document.getElementById("rename-acquis-btn"),
  deleteAcquisBtn: document.getElementById("delete-acquis-btn"),
  manageSousAcquisSelect: document.getElementById("manage-sous-acquis-select"),
  manageSousAcquisName: document.getElementById("manage-sous-acquis-name"),
  renameSousAcquisBtn: document.getElementById("rename-sous-acquis-btn"),
  deleteSousAcquisBtn: document.getElementById("delete-sous-acquis-btn"),
  manageQuizSelect: document.getElementById("manage-quiz-select"),
  manageQuizTitle: document.getElementById("manage-quiz-title"),
  renameQuizBtn: document.getElementById("rename-quiz-btn"),
  deleteQuizBtn: document.getElementById("delete-quiz-btn"),

  teacherForm: document.getElementById("teacher-form"),
  teacherFormTitle: document.getElementById("teacher-form-title"),
  teacherSubmitBtn: document.getElementById("teacher-submit-btn"),
  teacherCancelEdit: document.getElementById("teacher-cancel-edit"),
  teacherTable: document.getElementById("teacher-table"),
  classForm: document.getElementById("class-form"),
  classTeacherSelect: document.getElementById("class-teacher-select"),
  studentForm: document.getElementById("student-form"),
  studentFormTitle: document.getElementById("student-form-title"),
  studentSubmitBtn: document.getElementById("student-submit-btn"),
  studentCancelEdit: document.getElementById("student-cancel-edit"),
  studentAddBtn: document.getElementById("student-add-btn"),
  studentModal: document.getElementById("student-modal"),
  studentModalTitle: document.getElementById("student-modal-title"),
  studentModalClose: document.getElementById("student-modal-close"),
  studentModalChooser: document.getElementById("student-modal-chooser"),
  studentModalSingle: document.getElementById("student-modal-single"),
  studentModalImport: document.getElementById("student-modal-import"),
  studentModalOpenSingle: document.getElementById("student-modal-open-single"),
  studentModalOpenImport: document.getElementById("student-modal-open-import"),
  studentSearchInput: document.getElementById("student-search-input"),
  importStudentsForm: document.getElementById("import-students-form"),
  importClassSelect: document.getElementById("import-class-select"),
  importStudentsFile: document.getElementById("import-students-file"),
  accessForm: document.getElementById("access-form"),
  scheduleForm: document.getElementById("schedule-form"),
  scheduleStartDate: document.getElementById("schedule-start-date"),
  scheduleDatePicker: document.getElementById("schedule-date-picker"),
  scheduleDateTrigger: document.getElementById("schedule-date-trigger"),
  scheduleDateTriggerLabel: document.getElementById("schedule-date-trigger-label"),
  scheduleDatePopup: document.getElementById("schedule-date-popup"),
  scheduleDateMonthLabel: document.getElementById("schedule-date-month-label"),
  scheduleDateGrid: document.getElementById("schedule-date-grid"),
  scheduleDatePrev: document.getElementById("schedule-date-prev"),
  scheduleDateNext: document.getElementById("schedule-date-next"),
  studentClassSelect: document.getElementById("student-class-select"),
  accessClassSelect: document.getElementById("access-class-select"),
  accessModuleSelect: document.getElementById("access-module-select"),
  classAccessTable: document.getElementById("class-access-table"),
  classTable: document.getElementById("class-table"),
  studentTable: document.getElementById("student-table"),
  classesCreateFormCard: document.querySelector(".classes-create-form-card"),
  classDetailName: document.getElementById("class-detail-name"),
  classDetailTeacher: document.getElementById("class-detail-teacher"),
  classDetailBack: document.getElementById("class-detail-back"),
  classDetailAddBtn: document.getElementById("class-detail-add-btn"),
  classDetailStudentTable: document.getElementById("class-detail-student-table")
};

const scheduleDatePickerState = {
  month: 0,
  year: 0,
  open: false
};

bindEvents();
setupAiQuizPanel({
  prefix: "add-ai",
  getContext: () => {
    const mod = findModule(contentEditorState.moduleId);
    const acquis = subInsertState.acquisId
      ? (mod?.acquis || []).find((entry) => entry.id === subInsertState.acquisId)
      : null;
    const acquisName = acquis?.name || mod?.acquis?.[0]?.name || "";
    return {
      moduleId: contentEditorState.moduleId,
      subAcquisId: "",
      subAcquisName: String(dom.moduleAddSubForm?.subName?.value || "").trim(),
      acquisName
    };
  },
  onValidate: (title, questions) => {
    pendingSubQuizDraft.title = title;
    pendingSubQuizDraft.type = "qcm";
    pendingSubQuizDraft.questions = questions;
    if (dom.subQuizBuilderStatus) {
      dom.subQuizBuilderStatus.textContent = `${questions.length} question(s) générée(s) par IA ✓`;
    }
    showToast(`${questions.length} question(s) ajoutée(s) au quiz`);
  }
});
setupAiQuizPanel({
  prefix: "edit-ai",
  getContext: () => {
    const ctx = findSubAcquisContext(contentEditorState.moduleId, contentEditorState.subAcquisId);
    return {
      moduleId: contentEditorState.moduleId,
      subAcquisId: contentEditorState.subAcquisId,
      subAcquisName: String(dom.subEditName?.value || "").trim(),
      acquisName: ctx?.acquis?.name || ""
    };
  },
  onValidate: (title, questions) => {
    if (dom.subEditQuizTitle) dom.subEditQuizTitle.value = title;
    if (dom.subEditQuizType) dom.subEditQuizType.value = "qcm";
    if (dom.subEditQuizQuestions) {
      dom.subEditQuizQuestions.value = JSON.stringify(questions, null, 2);
    }
    showToast(`${questions.length} question(s) prête(s) — enregistrez pour sauvegarder`);
  }
});
initBackoffice();

async function initBackoffice() {
  backofficeUser = loadBackofficeUser();
  renderSidebarIdentity();
  applyBackofficePermissions();
  await Promise.all([
    hydrateOrganizationFromApi(),
    hydrateCurriculumFromApi(),
    hydrateCurriculumOverviewFromApi(),
    hydrateCurriculumNamesFromFile()
  ]);
  curriculumSyncEnabled = true;
  refreshAll();
  setModuleWorkspaceMode("list");
  // Ensure panel header matches the initially active view
  const activeViewKey = Object.keys(dom.views).find((k) => dom.views[k]?.classList.contains("active")) || "overview";
  switchView(activeViewKey);
}

function renderSidebarIdentity() {
  if (!dom.sidebarUserName || !dom.sidebarUserRole) {
    return;
  }

  const fullName = String(backofficeUser?.fullName || backofficeUser?.name || "Utilisateur").trim();
  const role = String(backofficeUser?.role || "teacher").trim().toLowerCase();
  const normalizedRole = role === "admin" ? "admin" : "enseignant";

  dom.sidebarUserName.textContent = fullName || "Utilisateur";
  // Dynamic value slot: drop the i18n key before writing the real role, otherwise
  // a later translation pass relabels an admin as "Teacher".
  dom.sidebarUserRole.removeAttribute("data-i18n");
  dom.sidebarUserRole.textContent = normalizedRole;
  dom.sidebarUserRole.classList.toggle("is-admin", normalizedRole === "admin");
  dom.sidebarUserRole.classList.toggle("is-teacher", normalizedRole === "enseignant");
}

function loadBackofficeUser() {
  try {
    const raw = localStorage.getItem("nextlearnCurrentTeacher");
    return raw ? JSON.parse(raw) : null;
  } catch (_error) {
    return null;
  }
}

function applyBackofficePermissions() {
  const isAdmin = String(backofficeUser?.role || "enseignant").toLowerCase() === "admin";

  const teacherNavItem = dom.navItems.find((item) => item.dataset.view === "teachers") || null;
  if (teacherNavItem) {
    teacherNavItem.hidden = !isAdmin;
  }

  const classesAccessNavItem = dom.navItems.find((item) => item.dataset.view === "classes-access") || null;
  if (classesAccessNavItem) {
    classesAccessNavItem.hidden = !isAdmin;
  }

  if (!isAdmin && dom.views.teachers?.classList.contains("active")) {
    switchView("overview");
  }

  if (!isAdmin && dom.views["classes-access"]?.classList.contains("active")) {
    switchView("overview");
  }

  if (dom.classesCreateFormCard) {
    dom.classesCreateFormCard.hidden = !isAdmin;
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return structuredClone(initialData);
    }
    const parsed = JSON.parse(raw);
    return normalizeState(parsed);
  } catch (_error) {
    return structuredClone(initialData);
  }
}

function normalizeState(value) {
  const safeValue = value && typeof value === "object" ? value : {};
  const classes = Array.isArray(safeValue.classes) ? safeValue.classes : [];
  const studentsRaw = Array.isArray(safeValue.students) ? safeValue.students : [];

  const providedTeachers = Array.isArray(safeValue.teachers) ? safeValue.teachers : [];
  const teacherByName = new Map();

  providedTeachers.forEach((teacher) => {
    if (!teacher || !teacher.name) return;
    const normalizedName = String(teacher.name).trim();
    if (!normalizedName) return;
    const normalizedEmail = String(teacher.email || "").trim().toLowerCase();
    const normalizedPhone = String(teacher.phone || "").trim();
    teacherByName.set(normalizedName.toLowerCase(), {
      id: teacher.id || uniqueId("tch"),
      role: String(teacher.role || "teacher").toLowerCase() === "admin" ? "admin" : "teacher",
      name: normalizedName,
      email: normalizedEmail,
      phone: normalizedPhone
    });
  });

  classes.forEach((room) => {
    const classTeacher = room?.teacherName;
    if (!classTeacher) return;
    const normalizedName = String(classTeacher).trim();
    if (!normalizedName) return;
    if (!teacherByName.has(normalizedName.toLowerCase())) {
      teacherByName.set(normalizedName.toLowerCase(), {
        id: uniqueId("tch"),
        role: "teacher",
        name: normalizedName,
        email: "",
        phone: ""
      });
    }
  });

  const teachers = Array.from(teacherByName.values());

  const teacherById = new Map(teachers.map((teacher) => [teacher.id, teacher.name]));
  const teacherIdByName = new Map(teachers.map((teacher) => [teacher.name.toLowerCase(), teacher.id]));

  const normalizedClasses = classes.map((room) => {
    if (!room || typeof room !== "object") return room;

    const normalizedTeacherName = String(room.teacherName || "").trim();
    const hasTeacherId = room.teacherId && teacherById.has(room.teacherId);

    const teacherId = hasTeacherId
      ? room.teacherId
      : teacherIdByName.get(normalizedTeacherName.toLowerCase()) || "";

    const teacherName = teacherId
      ? teacherById.get(teacherId)
      : normalizedTeacherName || "Enseignant non assigné";

    return {
      ...room,
      teacherId,
      teacherName
    };
  });

  const normalizedStudents = studentsRaw.map((student, index) => {
    const email = String(student?.email || "").trim().toLowerCase();
    const fallbackFromEmail = email.includes("@") ? email.split("@")[0] : "";
    const identifier = String(student?.identifier || "").trim() || fallbackFromEmail || `stu-${index + 1}`;

    return {
      ...student,
      identifier,
      email
    };
  });

  return {
    teachers,
    modules: Array.isArray(safeValue.modules) ? safeValue.modules : [],
    classes: normalizedClasses,
    students: normalizedStudents
  };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));

  if (curriculumSyncEnabled) {
    void saveCurriculumToApi();
  }
}

async function saveCurriculumToApi() {
  try {
    await fetch("/api/backoffice/curriculum", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: state.modules })
    });
  } catch (_error) {
    // Keep localStorage as a fallback if the API is temporarily unavailable.
  }
}

async function parseApiError(response, fallbackMessage) {
  try {
    const payload = await response.json();
    return payload?.message || payload?.error || fallbackMessage;
  } catch (_error) {
    return fallbackMessage;
  }
}

async function hydrateOrganizationFromApi() {
  try {
    const headers = {};
    const userId = String(backofficeUser?.id || "").trim();
    if (userId) headers["X-Teacher-Id"] = userId;
    const response = await fetch("/api/backoffice/organization", { headers });
    if (!response.ok) {
      return;
    }

    const payload = await response.json();

    state = normalizeState({
      ...state,
      teachers: Array.isArray(payload.teachers) ? payload.teachers : [],
      classes: Array.isArray(payload.classes) ? payload.classes : [],
      students: Array.isArray(payload.students) ? payload.students : []
    });

    saveState();
  } catch (_error) {
    // Keep local fallback state if API is unavailable.
  }
}

async function hydrateCurriculumFromApi() {
  try {
    const response = await fetch("/api/backoffice/curriculum");
    if (!response.ok) {
      return;
    }

    const payload = await response.json();
    const modules = Array.isArray(payload.modules) ? payload.modules : [];

    if (modules.length > 0) {
      state.modules = modules;
      saveState();
    }
  } catch (_error) {
    // Keep localStorage fallback if the curriculum API is unavailable.
  }
}

async function hydrateCurriculumOverviewFromApi() {
  try {
    const response = await fetch("/api/programmation-c/overview");
    if (!response.ok) {
      curriculumOverview = [];
      return;
    }

    const payload = await response.json();
    curriculumOverview = Array.isArray(payload.modules) ? payload.modules : [];
  } catch (_error) {
    curriculumOverview = [];
  }
}

function stripTrailingLevelNumber(value) {
  return String(value || "")
    .replace(/\s+\d+\s*$/, "")
    .trim();
}

function parseCurriculumNamesText(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const modulesById = {};
  const subAcquisById = {};

  lines.forEach((line) => {
    const moduleMatch = line.match(/^(\d+)\.\s*(.+)$/);
    if (moduleMatch && !line.startsWith("-")) {
      const moduleId = moduleMatch[1];
      const label = stripTrailingLevelNumber(moduleMatch[2]);
      if (moduleId && label) {
        modulesById[moduleId] = label;
      }
      return;
    }

    const subMatch = line.match(/^-\s*(\d+)\s*\.\s*(\d+)\s*\.?\s*(.+)$/);
    if (subMatch) {
      const moduleId = subMatch[1];
      const subId = subMatch[2];
      const label = stripTrailingLevelNumber(subMatch[3]);
      const key = `${moduleId}.${subId}`;
      if (label) {
        subAcquisById[key] = label;
      }
    }
  });

  return {
    modulesById,
    subAcquisById
  };
}

async function hydrateCurriculumNamesFromFile() {
  try {
    const response = await fetch("/Support_Cours_Pr%C3%A9paration/modules+noms.txt");
    if (!response.ok) {
      curriculumNames = { modulesById: {}, subAcquisById: {} };
      return;
    }

    const text = await response.text();
    curriculumNames = parseCurriculumNamesText(text);
  } catch (_error) {
    curriculumNames = { modulesById: {}, subAcquisById: {} };
  }
}

function bindEvents() {
  dom.navItems.forEach((button) => {
    if (!button.dataset.view) return; // skip non-view buttons (theme/CVD toggles)
    button.addEventListener("click", () => switchView(button.dataset.view));
  });

  dom.contentSwitchButtons.forEach((button) => {
    button.addEventListener("click", () => {
      switchContentPanel(button.dataset.contentPanel);
    });
  });

  dom.studentsSwitchButtons.forEach((button) => {
    button.addEventListener("click", () => {
      switchStudentsPanel(button.dataset.studentsPanel);
    });
  });

  dom.overviewClassFilter.addEventListener("change", () => {
    populateOverviewStudentFilter();
    renderOverview();
  });

  dom.overviewStudentFilter.addEventListener("change", renderOverview);

  dom.moduleForm?.addEventListener("submit", onAddModule);
  dom.sousAcquisForm?.addEventListener("submit", onAddSousAcquis);

  dom.quizModuleSelect?.addEventListener("change", () => {
    populateSousAcquisByModuleSelect(dom.quizModuleSelect, dom.quizSousAcquisSelect);
  });

  dom.addQuestionBtn?.addEventListener("click", onAddDraftQuestion);
  dom.saveQuizBtn?.addEventListener("click", onSaveQuiz);

  dom.contentManagementList?.addEventListener("click", onContentManagementListClick);
  dom.addModuleBtn?.addEventListener("click", () => openInsertModulePage(state.modules.length));
  dom.moduleInsertForm?.addEventListener("submit", onInsertModuleAtPosition);
  dom.moduleInsertCancel?.addEventListener("click", closeContentEditors);
  dom.moduleInsertCancelBottom?.addEventListener("click", closeContentEditors);
  dom.moduleEditorSubList?.addEventListener("click", onContentManagementListClick);
  dom.moduleEditorClose?.addEventListener("click", closeContentEditors);
  dom.moduleEditForm?.addEventListener("submit", onSaveModuleEditor);
  dom.moduleDeleteBtn?.addEventListener("click", onDeleteModuleFromEditor);
  dom.moduleAddSubCancel?.addEventListener("click", () => {
    closeSubInsertEditor();
    dom.moduleAddSubForm?.reset();
    resetPendingSubQuizDraft();
    switchView("content");
  });
  dom.moduleAddSubForm?.addEventListener("submit", onAddSubFromModuleEditor);
  dom.openSubQuizBuilderBtn?.addEventListener("click", openSubQuizBuilderPage);
  dom.subQuizBuilderBack?.addEventListener("click", onBackToModuleAddSubForm);
  dom.subQuizAddOption?.addEventListener("click", onAddSubQuizOptionField);
  dom.subQuizOptionsList?.addEventListener("click", onSubQuizOptionsListClick);
  dom.subQuizOptionsList?.addEventListener("input", onSubQuizOptionsListInput);
  dom.subQuizAddQuestion?.addEventListener("click", onAddQuestionToPendingSubQuiz);
  dom.subQuizClear?.addEventListener("click", onClearPendingSubQuiz);
  dom.subEditorBack?.addEventListener("click", onBackToModuleEditor);
  dom.subEditForm?.addEventListener("submit", onSaveSubEditor);
  dom.subEditDeleteBtn?.addEventListener("click", onDeleteSubFromEditor);
  dom.subEditExistingFiles?.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-file-id]");
    if (!btn) return;
    subEditorPendingDeleteIds.add(btn.dataset.fileId);
    const context = findSubAcquisContext(contentEditorState.moduleId, contentEditorState.subAcquisId);
    renderSubEditorExistingFiles(context?.subAcquis?.courseFiles || []);
  });
  dom.subEditQuizSelect?.addEventListener("change", populateSubEditorQuizFields);

  dom.manageModuleSelect?.addEventListener("change", populateManagedAcquisSelect);
  dom.manageAcquisSelect?.addEventListener("change", populateManagedSousAcquisSelect);
  dom.manageSousAcquisSelect?.addEventListener("change", populateManagedQuizSelect);
  dom.manageQuizSelect?.addEventListener("change", syncManageQuizInput);

  dom.renameAcquisBtn?.addEventListener("click", onRenameAcquis);
  dom.deleteAcquisBtn?.addEventListener("click", onDeleteAcquis);
  dom.renameSousAcquisBtn?.addEventListener("click", onRenameSousAcquis);
  dom.deleteSousAcquisBtn?.addEventListener("click", onDeleteSousAcquis);
  dom.renameQuizBtn?.addEventListener("click", onRenameQuiz);
  dom.deleteQuizBtn?.addEventListener("click", onDeleteQuiz);

  dom.teacherForm.addEventListener("submit", onAddTeacher);
  dom.teacherTable?.addEventListener("click", onTeacherTableClick);
  dom.teacherCancelEdit?.addEventListener("click", resetTeacherFormMode);
  dom.classForm.addEventListener("submit", onAddClass);
  dom.studentAddBtn?.addEventListener("click", () => openStudentModal("chooser"));
  dom.studentModalClose?.addEventListener("click", closeStudentModal);
  dom.studentModal?.addEventListener("click", onStudentModalClick);
  dom.studentModalOpenSingle?.addEventListener("click", () => openStudentModal("single"));
  dom.studentModalOpenImport?.addEventListener("click", () => openStudentModal("import"));
  dom.studentForm.addEventListener("submit", onAddStudent);
  dom.studentTable?.addEventListener("click", onStudentTableClick);
  dom.studentCancelEdit?.addEventListener("click", resetStudentFormMode);
  dom.studentSearchInput?.addEventListener("input", onStudentSearchInput);
  dom.importStudentsForm.addEventListener("submit", onImportStudents);
  dom.classTable?.addEventListener("click", onClassTableClick);
  dom.classDetailBack?.addEventListener("click", () => {
    selectedClassId = "";
    switchView("classes-create");
  });
  dom.classDetailStudentTable?.addEventListener("click", onStudentTableClick);
  dom.classDetailAddBtn?.addEventListener("click", () => {
    openStudentModal("single");
    if (selectedClassId && dom.studentClassSelect) {
      dom.studentClassSelect.value = selectedClassId;
    }
  });
  dom.accessForm?.addEventListener("submit", onApplyAccess);
  dom.scheduleForm?.addEventListener("submit", onGenerateSchedule);

  dom.scheduleDateTrigger?.addEventListener("click", () => {
    if (scheduleDatePickerState.open) {
      closeScheduleDatePicker();
    } else {
      openScheduleDatePicker();
    }
  });

  dom.scheduleDatePrev?.addEventListener("click", () => {
    scheduleDatePickerState.month -= 1;
    if (scheduleDatePickerState.month < 0) {
      scheduleDatePickerState.month = 11;
      scheduleDatePickerState.year -= 1;
    }
    renderScheduleDatePicker();
  });

  dom.scheduleDateNext?.addEventListener("click", () => {
    scheduleDatePickerState.month += 1;
    if (scheduleDatePickerState.month > 11) {
      scheduleDatePickerState.month = 0;
      scheduleDatePickerState.year += 1;
    }
    renderScheduleDatePicker();
  });

  dom.scheduleDateGrid?.addEventListener("click", (event) => {
    const target = event.target instanceof HTMLElement ? event.target.closest("button[data-date]") : null;
    if (!target) {
      return;
    }

    const nextDate = String(target.getAttribute("data-date") || "").trim();
    if (!nextDate) {
      return;
    }

    setScheduleDateValue(nextDate);
    closeScheduleDatePicker();
  });

  document.addEventListener("click", (event) => {
    if (!scheduleDatePickerState.open || !dom.scheduleDatePicker) {
      return;
    }

    const target = event.target;
    if (target instanceof Node && dom.scheduleDatePicker.contains(target)) {
      return;
    }

    closeScheduleDatePicker();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeScheduleDatePicker();
    }
  });

}

function refreshAll() {
  populateModuleSelects();
  populateContentManagementSelects();
  populateTeacherSelects();
  populateClassSelects();
  populateOverviewFilters();
  renderOverview();
  renderContentTree();
  renderContentManagementWorkspace();
  renderDraftQuestions();
  renderTeachersTable();
  renderClassesTable();
  renderClassAccessTable();
  renderStudentsTable();
  renderClassDetailStudents();
  renderPendingSubQuizDraft();
}

function switchView(viewKey) {
  selectedClassId = "";
  const isAdmin = String(backofficeUser?.role || "enseignant").toLowerCase() === "admin";
  if (viewKey === "teachers" && !isAdmin) {
    viewKey = "overview";
  }

  const titles = {
    overview: {
      eyebrow: boTr("bo.overview", "Vue d'ensemble"),
      title: boTr("bo.overviewTitle", "Tableau de bord de progression")
    },
    content: {
      eyebrow: boTr("bo.moduleMgmt", "Gestion des modules"),
      title: ""
    },
    teachers: {
      eyebrow: boTr("bo.teacherMgmt", "Gestion des enseignants"),
      title: boTr("bo.teacherMgmtTitle", "Les enseignants et leurs classes")
    },
    "classes-create": {
      eyebrow: boTr("bo.classMgmt", "Gestion des classes"),
      title: boTr("bo.classMgmtTitle", "Les classes et leurs étudiants")
    },
    "classes-access": {
      eyebrow: boTr("bo.accessMgmt", "Date de démarrage des cours"),
      title: boTr("bo.accessMgmtTitle", "Calendrier des cours")
    },
    students: {
      eyebrow: boTr("bo.studentMgmt", "Gestion des étudiants"),
      title: ""
    },
    clustering: {
      eyebrow: boTr("bo.clustering", "Profils d'apprentissage"),
      title: ""
    },
    attention: {
      eyebrow: boTr("bo.attention", "Suivi d'attention"),
      title: boTr("bo.attentionTitle", "Concentration des étudiants")
    },
    "sub-add": {
      eyebrow: boTr("bo.moduleMgmt", "Gestion des modules"),
      title: ""
    },
    "sub-editor": {
      eyebrow: boTr("bo.moduleMgmt", "Gestion des modules"),
      title: ""
    }
  };

  dom.navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === viewKey));
  Object.entries(dom.views).forEach(([key, node]) => {
    if (node) node.classList.toggle("active", key === viewKey);
  });

  const titlePack = titles[viewKey] || titles.overview;
  if (dom.panelEyebrow) dom.panelEyebrow.textContent = titlePack.eyebrow;
  if (dom.panelTitle) dom.panelTitle.textContent = titlePack.title;

  if (viewKey === "content") {
    if (contentEditorState.moduleId) {
      setModuleWorkspaceMode("module-editor");
    } else {
      setModuleWorkspaceMode("list");
    }
  } else if (viewKey === "students") {
    closeStudentModal();
  } else if (viewKey === "clustering") {
    initClusteringViewOnce();
  } else if (viewKey === "attention") {
    initAttentionViewOnce();
  }
}

let attentionViewInitialized = false;

/**
 * First-visit setup of the attention view: loads the teacher's classes into
 * the selector and renders the dashboard for the first class. Subsequent
 * visits keep the current selection.
 */
async function initAttentionViewOnce() {
  if (attentionViewInitialized) return;
  if (typeof window.renderAttentionDashboard !== "function") {
    console.error("renderAttentionDashboard is not available — check that attentionDashboard.js loaded correctly.");
    return;
  }
  attentionViewInitialized = true;

  const select = document.getElementById("attention-class-select");
  const root = document.getElementById("attention-dashboard-root");
  if (!select || !root) return;

  try {
    const res = await fetch("/api/backoffice/classes", {
      headers: { "X-Teacher-Id": backofficeUser?.id || backofficeUser?._id || "" }
    });
    const data = res.ok ? await res.json() : { classes: [] };
    const classes = Array.isArray(data.classes) ? data.classes : [];

    if (!classes.length) {
      root.innerHTML = '<p style="color:#676c77">Aucune classe disponible.</p>';
      return;
    }

    select.innerHTML = classes
      .map((c) => `<option value="${htmlEscape(String(c.id))}">${htmlEscape(String(c.name || c.id))}</option>`)
      .join("");
    select.addEventListener("change", () => {
      window.renderAttentionDashboard("attention-dashboard-root", select.value);
    });

    window.renderAttentionDashboard("attention-dashboard-root", classes[0].id);
  } catch (error) {
    console.error("Failed to initialize attention view:", error);
    root.innerHTML = '<p style="color:#676c77">Impossible de charger les classes.</p>';
  }
}

let clusteringDashboardInitialized = false;

function initClusteringViewOnce() {
  if (clusteringDashboardInitialized) return;
  if (typeof window.initClusteringDashboard !== "function") {
    console.error("initClusteringDashboard is not available — check that clusteringDashboard.js loaded correctly.");
    return;
  }
  clusteringDashboardInitialized = true;
  window.initClusteringDashboard("clustering-dashboard-root");
}

function openStudentModal(mode = "chooser") {
  if (!dom.studentModal) {
    return;
  }

  dom.studentModal.hidden = false;
  showStudentModalPane(mode);
}

function closeStudentModal() {
  if (!dom.studentModal) {
    return;
  }

  dom.studentModal.hidden = true;
  showStudentModalPane("chooser");
  resetStudentFormMode();
}

function showStudentModalPane(mode = "chooser") {
  const resolvedMode = mode === "import" ? "import" : mode === "single" ? "single" : "chooser";
  if (dom.studentModalTitle) {
    dom.studentModalTitle.textContent =
      resolvedMode === "single"
        ? "Ajouter un étudiant"
        : resolvedMode === "import"
          ? "Importer une classe (JSON)"
          : "Choisir une action";
  }

  if (dom.studentModalChooser) dom.studentModalChooser.hidden = resolvedMode !== "chooser";
  if (dom.studentModalSingle) dom.studentModalSingle.hidden = resolvedMode !== "single";
  if (dom.studentModalImport) dom.studentModalImport.hidden = resolvedMode !== "import";
}

function onStudentModalClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const closeTrigger = target.closest("[data-action='close-student-modal']");
  if (closeTrigger) {
    closeStudentModal();
  }
}

function switchContentPanel(panelKey) {
  const fallbackKey = "module";
  const resolvedKey = panelKey && dom.contentPanels[panelKey] ? panelKey : fallbackKey;

  dom.contentSwitchButtons.forEach((button) => {
    const isActive = button.dataset.contentPanel === resolvedKey;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  Object.entries(dom.contentPanels).forEach(([key, node]) => {
    if (!node) {
      return;
    }

    const isActive = key === resolvedKey;
    node.classList.toggle("active", isActive);
    node.setAttribute("aria-hidden", isActive ? "false" : "true");
  });

  if (resolvedKey !== "module") {
    closeContentEditors();
  } else {
    setModuleWorkspaceMode("list");
  }
}

function setModuleWorkspaceMode(mode) {
  const resolvedMode = mode || "list";
  const isList = resolvedMode === "list";
  const isInsertPage = resolvedMode === "insert-module";
  const isModuleEditor = resolvedMode === "module-editor";

  if (dom.moduleIntroGrid) dom.moduleIntroGrid.hidden = !isList;
  if (dom.moduleManagementCard) dom.moduleManagementCard.hidden = !isList;
  if (dom.moduleInsertPage) dom.moduleInsertPage.hidden = !isInsertPage;
  if (dom.moduleEditorPage) dom.moduleEditorPage.hidden = !isModuleEditor;
}

function switchStudentsPanel(panelKey) {
  const fallbackKey = "add-single";
  const resolvedKey = panelKey && dom.studentsPanels[panelKey] ? panelKey : fallbackKey;

  dom.studentsSwitchButtons.forEach((button) => {
    const isActive = button.dataset.studentsPanel === resolvedKey;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  Object.entries(dom.studentsPanels).forEach(([key, node]) => {
    if (!node) {
      return;
    }

    const isActive = key === resolvedKey;
    node.classList.toggle("active", isActive);
    node.setAttribute("aria-hidden", isActive ? "false" : "true");
  });
}

function uniqueId(prefix) {
  return `${prefix}-${Math.random().toString(16).slice(2, 8)}`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Impossible de lire le fichier"));
    reader.readAsDataURL(file);
  });
}

async function uploadCourseResource({ moduleId, subAcquisId, file }) {
  const fileDataUrl = await readFileAsDataUrl(file);

  const response = await fetch("/api/backoffice/upload-course-file", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      moduleId,
      subAcquisId,
      fileName: file.name,
      fileType: file.type || "application/pdf",
      fileDataUrl
    })
  });

  if (!response.ok) {
    throw new Error("Upload course file failed");
  }

  return response.json();
}

function htmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setOptions(selectNode, items, includeAll = false) {
  if (!selectNode) {
    return;
  }
  const optionMarkup = [];
  if (includeAll) {
    optionMarkup.push('<option value="all">Tous</option>');
  }

  items.forEach((item) => {
    optionMarkup.push(`<option value="${htmlEscape(item.id)}">${htmlEscape(item.name)}</option>`);
  });

  selectNode.innerHTML = optionMarkup.join("");

  if (!items.length && !includeAll) {
    selectNode.innerHTML = '<option value="">Aucune donnée disponible</option>';
  }
}

function accessStatusLabel(status) {
  return status === "granted" ? "autorisé" : "bloqué";
}

function formatIsoDateLabel(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) {
    return "Non defini";
  }

  return new Intl.DateTimeFormat("fr-TN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function toDateInputValue(value) {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateInputLabel(value) {
  const parsed = String(value || "").trim();
  if (!parsed) {
    return "Choisir une date";
  }

  const date = new Date(`${parsed}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return "Choisir une date";
  }

  return new Intl.DateTimeFormat("fr-TN", {
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "2-digit"
  }).format(date);
}

function setScheduleDateValue(value) {
  if (!dom.scheduleStartDate) {
    return;
  }

  dom.scheduleStartDate.value = String(value || "").trim();
  if (dom.scheduleDateTriggerLabel) {
    dom.scheduleDateTriggerLabel.textContent = formatDateInputLabel(dom.scheduleStartDate.value);
  }

  const date = new Date(`${dom.scheduleStartDate.value}T00:00:00Z`);
  if (!Number.isNaN(date.getTime())) {
    scheduleDatePickerState.year = date.getUTCFullYear();
    scheduleDatePickerState.month = date.getUTCMonth();
  }
}

function renderScheduleDatePicker() {
  if (!dom.scheduleDateGrid || !dom.scheduleDateMonthLabel) {
    return;
  }

  const firstDay = new Date(Date.UTC(scheduleDatePickerState.year, scheduleDatePickerState.month, 1));
  const firstWeekday = (firstDay.getUTCDay() + 6) % 7;
  const monthStart = new Date(Date.UTC(scheduleDatePickerState.year, scheduleDatePickerState.month, 1));
  monthStart.setUTCDate(monthStart.getUTCDate() - firstWeekday);

  const selectedDate = String(dom.scheduleStartDate?.value || "").trim();
  const today = toDateInputValue(new Date().toISOString());

  dom.scheduleDateMonthLabel.textContent = new Intl.DateTimeFormat("fr-TN", {
    month: "long",
    year: "numeric"
  }).format(firstDay);

  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const cellDate = new Date(monthStart);
    cellDate.setUTCDate(monthStart.getUTCDate() + index);

    const y = cellDate.getUTCFullYear();
    const m = String(cellDate.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cellDate.getUTCDate()).padStart(2, "0");
    const iso = `${y}-${m}-${d}`;

    const isOutside = cellDate.getUTCMonth() !== scheduleDatePickerState.month;
    const isSelected = iso === selectedDate;
    const isToday = iso === today;

    cells.push(`
      <button
        type="button"
        class="schedule-date-cell${isOutside ? " is-outside" : ""}${isToday ? " is-today" : ""}${isSelected ? " is-selected" : ""}"
        data-date="${htmlEscape(iso)}"
        aria-label="${htmlEscape(iso)}"
      >${cellDate.getUTCDate()}</button>
    `);
  }

  dom.scheduleDateGrid.innerHTML = cells.join("");
}

function openScheduleDatePicker() {
  if (!dom.scheduleDatePopup) {
    return;
  }

  const selected = String(dom.scheduleStartDate?.value || "").trim();
  const date = selected ? new Date(`${selected}T00:00:00Z`) : new Date();
  scheduleDatePickerState.year = Number.isNaN(date.getTime()) ? new Date().getUTCFullYear() : date.getUTCFullYear();
  scheduleDatePickerState.month = Number.isNaN(date.getTime()) ? new Date().getUTCMonth() : date.getUTCMonth();

  scheduleDatePickerState.open = true;
  dom.scheduleDatePopup.hidden = false;
  if (dom.scheduleDateTrigger) {
    dom.scheduleDateTrigger.setAttribute("aria-expanded", "true");
  }
  renderScheduleDatePicker();
}

function closeScheduleDatePicker() {
  if (!dom.scheduleDatePopup) {
    return;
  }

  scheduleDatePickerState.open = false;
  dom.scheduleDatePopup.hidden = true;
  if (dom.scheduleDateTrigger) {
    dom.scheduleDateTrigger.setAttribute("aria-expanded", "false");
  }
}

function syncScheduleFormDefaults() {
  if (!dom.scheduleStartDate) {
    return;
  }

  const firstScheduledClass = state.classes.find((entry) => entry?.scheduleStartDate);
  setScheduleDateValue(toDateInputValue(firstScheduledClass?.scheduleStartDate));
}

function curriculumTotals() {
  return state.modules.reduce(
    (acc, module) => {
      module.acquis.forEach((acquis) => {
        acquis.sousAcquis.forEach((sousAcquis) => {
          acc.lessons += Number(sousAcquis.lessonsCount || 0);
          acc.quizzes += Array.isArray(sousAcquis.quizzes) ? sousAcquis.quizzes.length : 0;
        });
      });
      return acc;
    },
    { lessons: 0, quizzes: 0 }
  );
}

function percentage(value, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

function findModule(moduleId) {
  return state.modules.find((module) => module.id === moduleId);
}

function findAcquis(moduleId, acquisId) {
  const module = findModule(moduleId);
  if (!module) return null;
  return module.acquis.find((item) => item.id === acquisId) || null;
}

function findSousAcquis(moduleId, sousAcquisId) {
  const module = findModule(moduleId);
  if (!module || !Array.isArray(module.acquis)) return null;

  for (const acquis of module.acquis) {
    const found = Array.isArray(acquis.sousAcquis)
      ? acquis.sousAcquis.find((item) => item.id === sousAcquisId)
      : null;
    if (found) {
      return found;
    }
  }

  return null;
}

function listSousAcquisByModule(moduleId) {
  const module = findModule(moduleId);
  if (!module || !Array.isArray(module.acquis)) return [];

  return module.acquis.flatMap((acquis) =>
    (Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : []).map((item) => ({
      id: item.id,
      name: item.name
    }))
  );
}

function listSousAcquisOptionsByModule(moduleId) {
  const fromOverview =
    Array.isArray(curriculumOverview) && curriculumOverview.length
      ? curriculumOverview.find((moduleData) => String(moduleData.id || "") === String(moduleId || ""))
      : null;

  if (fromOverview && Array.isArray(fromOverview.subAcquis)) {
    return fromOverview.subAcquis.map((entry) => {
      const id = String(entry?.id || "");
      return {
        id,
        name: curriculumNames.subAcquisById[id] || id || "Sous-acquis"
      };
    });
  }

  return listSousAcquisByModule(moduleId);
}

function getOrCreateDefaultAcquis(module) {
  if (!module) return null;

  if (!Array.isArray(module.acquis)) {
    module.acquis = [];
  }

  let defaultAcquis = module.acquis.find((item) => item.isDefaultBucket);

  if (!defaultAcquis) {
    defaultAcquis = {
      id: uniqueId("acq"),
      name: "Sous-acquis du module",
      isDefaultBucket: true,
      sousAcquis: []
    };
    // ensure this helper doesn't pollute titles here
    module.acquis.push(defaultAcquis);
  }

  if (!Array.isArray(defaultAcquis.sousAcquis)) {
    defaultAcquis.sousAcquis = [];
  }

  return defaultAcquis;
}

function populateModuleSelects() {
  const modules = state.modules.map((module) => ({ id: module.id, name: module.name }));
  const accessModules =
    Array.isArray(curriculumOverview) && curriculumOverview.length
      ? curriculumOverview.map((moduleData) => {
          const moduleId = String(moduleData.id || "");
          const matchingModule = state.modules.find((item) => item.id === moduleId);
          const moduleNameFromFile = curriculumNames.modulesById[moduleId];
          return {
            id: moduleId,
            name: moduleNameFromFile || matchingModule?.name || `Module ${moduleId}`
          };
        })
      : modules;
  const quizModules =
    Array.isArray(curriculumOverview) && curriculumOverview.length ? accessModules : modules;

  if (dom.sousModuleSelect) {
    setOptions(dom.sousModuleSelect, accessModules);
  }

  if (dom.quizModuleSelect) {
    setOptions(dom.quizModuleSelect, quizModules);
  }

  setOptions(dom.accessModuleSelect, accessModules);

  if (dom.quizModuleSelect && dom.quizSousAcquisSelect) {
    populateSousAcquisByModuleSelect(dom.quizModuleSelect, dom.quizSousAcquisSelect);
  }
}

function populateSousAcquisByModuleSelect(moduleSelect, targetSelect) {
  if (!moduleSelect || !targetSelect) {
    return;
  }

  const sousAcquisItems = listSousAcquisOptionsByModule(moduleSelect.value);
  setOptions(targetSelect, sousAcquisItems);
}

function populateContentManagementSelects() {
  if (!dom.manageModuleSelect) {
    return;
  }

  const modules = state.modules.map((module) => ({ id: module.id, name: module.name }));
  setOptions(dom.manageModuleSelect, modules);
  populateManagedAcquisSelect();
}

function populateManagedAcquisSelect() {
  if (!dom.manageAcquisSelect) {
    return;
  }

  const module = findModule(dom.manageModuleSelect.value);
  const acquisItems = Array.isArray(module?.acquis)
    ? module.acquis.map((acquis) => ({ id: acquis.id, name: acquis.name }))
    : [];

  setOptions(dom.manageAcquisSelect, acquisItems);
  const selectedAcquis = Array.isArray(module?.acquis)
    ? module.acquis.find((acquis) => acquis.id === dom.manageAcquisSelect.value)
    : null;

  if (dom.manageAcquisName) {
    dom.manageAcquisName.value = selectedAcquis?.name || "";
  }

  populateManagedSousAcquisSelect();
}

function populateManagedSousAcquisSelect() {
  if (!dom.manageSousAcquisSelect) {
    return;
  }

  const module = findModule(dom.manageModuleSelect.value);
  const acquis = Array.isArray(module?.acquis)
    ? module.acquis.find((item) => item.id === dom.manageAcquisSelect.value)
    : null;

  const sousAcquisItems = Array.isArray(acquis?.sousAcquis)
    ? acquis.sousAcquis.map((entry) => ({ id: entry.id, name: entry.name }))
    : [];

  setOptions(dom.manageSousAcquisSelect, sousAcquisItems);
  const selectedSousAcquis = Array.isArray(acquis?.sousAcquis)
    ? acquis.sousAcquis.find((entry) => entry.id === dom.manageSousAcquisSelect.value)
    : null;

  if (dom.manageSousAcquisName) {
    dom.manageSousAcquisName.value = selectedSousAcquis?.name || "";
  }

  populateManagedQuizSelect();
}

function populateManagedQuizSelect() {
  if (!dom.manageQuizSelect) {
    return;
  }

  const module = findModule(dom.manageModuleSelect.value);
  const acquis = Array.isArray(module?.acquis)
    ? module.acquis.find((item) => item.id === dom.manageAcquisSelect.value)
    : null;
  const sousAcquis = Array.isArray(acquis?.sousAcquis)
    ? acquis.sousAcquis.find((entry) => entry.id === dom.manageSousAcquisSelect.value)
    : null;

  const quizItems = Array.isArray(sousAcquis?.quizzes)
    ? sousAcquis.quizzes.map((quiz, index) => ({
        id: quiz.id,
        name: quiz.title || `Quiz ${index + 1}`
      }))
    : [];

  setOptions(dom.manageQuizSelect, quizItems);
  syncManageQuizInput();
}

function syncManageQuizInput() {
  if (!dom.manageQuizTitle) {
    return;
  }

  const module = findModule(dom.manageModuleSelect.value);
  const acquis = Array.isArray(module?.acquis)
    ? module.acquis.find((item) => item.id === dom.manageAcquisSelect.value)
    : null;
  const sousAcquis = Array.isArray(acquis?.sousAcquis)
    ? acquis.sousAcquis.find((entry) => entry.id === dom.manageSousAcquisSelect.value)
    : null;
  const quiz = Array.isArray(sousAcquis?.quizzes)
    ? sousAcquis.quizzes.find((entry) => entry.id === dom.manageQuizSelect.value)
    : null;

  dom.manageQuizTitle.value = quiz?.title || "";
}

function populateTeacherSelects() {
  const teachers = state.teachers.map((teacher) => ({ id: teacher.id, name: teacher.name }));
  setOptions(dom.classTeacherSelect, teachers);
}

function populateClassSelects() {
  const classes = state.classes.map((room) => ({ id: room.id, name: room.name }));
  setOptions(dom.studentClassSelect, classes);
  setOptions(dom.importClassSelect, classes);
  setOptions(dom.accessClassSelect, classes);
  syncScheduleFormDefaults();
}

function isAdminUser() {
  return String(backofficeUser?.role || "enseignant").toLowerCase() === "admin";
}

function normalizeName(value) {
  return String(value || "").trim().toLowerCase();
}

function getTeacherScope() {
  if (isAdminUser()) {
    return { teacherId: "", teacherName: "" };
  }

  const teacherId = String(backofficeUser?.id || "").trim();
  const teacherName = String(backofficeUser?.fullName || backofficeUser?.name || "").trim();
  return { teacherId, teacherName };
}

function getScopedClasses() {
  if (isAdminUser()) {
    return state.classes;
  }

  const { teacherId, teacherName } = getTeacherScope();
  const normalizedTeacherName = normalizeName(teacherName);

  return state.classes.filter((room) => {
    if (!room) return false;
    if (teacherId && String(room.teacherId || "") === teacherId) return true;
    if (normalizedTeacherName && normalizeName(room.teacherName) === normalizedTeacherName) return true;
    return false;
  });
}

function getScopedStudents() {
  const scopedClasses = getScopedClasses();
  if (isAdminUser()) {
    return state.students;
  }

  const classIds = new Set(scopedClasses.map((room) => room.id));
  return state.students.filter((student) => classIds.has(student.classId));
}

function getTeacherNameByClass(room) {
  if (!room) return "Enseignant non assigné";
  if (room.teacherId) {
    const teacher = state.teachers.find((item) => item.id === room.teacherId);
    if (teacher) return teacher.name;
  }
  return room.teacherName || "Enseignant non assigné";
}

function populateOverviewFilters() {
  const classes = getScopedClasses().map((room) => ({ id: room.id, name: room.name }));
  setOptions(dom.overviewClassFilter, classes, true);
  populateOverviewStudentFilter();
}

function populateOverviewStudentFilter() {
  const classFilter = dom.overviewClassFilter.value;
  const filtered = getScopedStudents().filter((student) => {
    if (classFilter === "all") return true;
    return student.classId === classFilter;
  });

  const options = filtered.map((student) => ({ id: student.id, name: student.fullName }));
  setOptions(dom.overviewStudentFilter, options, true);
}

function getFilteredStudents() {
  const classFilter = dom.overviewClassFilter.value;
  const studentFilter = dom.overviewStudentFilter.value;

  return getScopedStudents().filter((student) => {
    const classMatch = classFilter === "all" || student.classId === classFilter;
    const studentMatch = studentFilter === "all" || student.id === studentFilter;
    return classMatch && studentMatch;
  });
}

function renderOverview() {
  const filteredStudents = getFilteredStudents();
  const totals = {
    students: filteredStudents.length,
    classes: classCountFromFiltered(filteredStudents),
    lessons: filteredStudents.reduce((sum, item) => sum + Number(item.lessonsCompleted || 0), 0),
    quizzes: filteredStudents.reduce((sum, item) => sum + Number(item.quizzesTaken || 0), 0),
    avgGrade: filteredStudents.length
      ? (
          filteredStudents.reduce((sum, item) => sum + Number(item.averageQuizGrade || 0), 0) /
          filteredStudents.length
        ).toFixed(2)
      : "0.00"
  };

  const cards = [
    { label: "Étudiants concernés", value: totals.students },
    { label: "Classes concernées", value: totals.classes },
    { label: "Leçons complétées", value: totals.lessons },
    { label: "Quiz passés", value: totals.quizzes },
    { label: "Moyenne des quiz", value: totals.avgGrade },
    { label: "Total des modules", value: state.modules.length }
  ];

  dom.kpiGrid.innerHTML = cards
    .map(
      (card) =>
        `<article class="kpi-card"><p>${htmlEscape(card.label)}</p><strong>${htmlEscape(
          card.value
        )}</strong></article>`
    )
    .join("");

  renderInsights(filteredStudents);
}

function classCountFromFiltered(filteredStudents) {
  const set = new Set(filteredStudents.map((student) => student.classId));
  return set.size;
}

function renderInsights(filteredStudents) {
  renderAtRiskStudents(filteredStudents);
  renderInactiveStudents(filteredStudents);
  renderClassGauges(filteredStudents);
  renderQuizStruggle(filteredStudents);
  renderModuleTable(filteredStudents);
}

/**
 * Risk = the complement of the model's catch-up probability.
 *
 * `catchupProbability` is the probability the student CATCHES UP, i.e. succeeds —
 * higher is better (the student dashboard prints it as "% de réussite"). Returns
 * null when the student has no prediction, so they are simply not ranked.
 */
function riskProbability(student) {
  const p = Number(student?.catchupProbability);
  return Number.isFinite(p) ? 1 - p : null;
}

function renderAtRiskStudents(filteredStudents) {
  if (!dom.atRiskList) return;

  // This list used to filter and sort on catchupProbability directly, which is
  // backwards: it surfaced the students with the BEST chance of succeeding as the
  // most "at risk", and dropped the genuinely failing ones (low catch-up chance)
  // out of the list entirely.
  const atRisk = filteredStudents
    .map((student) => ({ student, risk: riskProbability(student) }))
    .filter((entry) => entry.risk !== null && entry.risk >= 0.45)
    .sort((a, b) => b.risk - a.risk);

  if (!atRisk.length) {
    dom.atRiskList.innerHTML = '<p class="insight-empty">Aucun étudiant à risque détecté.</p>';
    return;
  }

  dom.atRiskList.innerHTML = atRisk.map(({ student, risk }) => {
    const pct = Math.round(risk * 100);
    const level = pct >= 75 ? "high" : "medium";
    const label = pct >= 75 ? "Risque élevé" : "Risque modéré";
    const room = state.classes.find((r) => r.id === student.classId);
    return `<div class="insight-row">
      <div class="insight-name">${htmlEscape(student.fullName)}</div>
      <div class="insight-meta">${htmlEscape(room?.name || "Sans classe")}</div>
      <span class="risk-badge risk-${level}">${label} · ${pct}%</span>
    </div>`;
  }).join("");
}

function renderInactiveStudents(filteredStudents) {
  if (!dom.inactiveList) return;
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const withDays = filteredStudents.map((student) => {
    const lastLogin = student.lastLoginDate ? new Date(student.lastLoginDate) : null;
    const daysAgo = lastLogin ? Math.floor((now - lastLogin.getTime()) / DAY) : null;
    return { ...student, daysAgo };
  });

  const inactive = withDays
    .filter((s) => s.daysAgo === null || s.daysAgo >= 7)
    .sort((a, b) => {
      if (a.daysAgo === null && b.daysAgo === null) return 0;
      if (a.daysAgo === null) return -1;
      if (b.daysAgo === null) return 1;
      return b.daysAgo - a.daysAgo;
    });

  if (!inactive.length) {
    dom.inactiveList.innerHTML = '<p class="insight-empty">Tous les étudiants sont actifs.</p>';
    return;
  }

  dom.inactiveList.innerHTML = inactive.map((student) => {
    const room = state.classes.find((r) => r.id === student.classId);
    const lastSeenText = student.daysAgo === null
      ? "Jamais connecté"
      : `Il y a ${student.daysAgo} jour${student.daysAgo > 1 ? "s" : ""}`;
    return `<div class="insight-row">
      <div class="insight-name">${htmlEscape(student.fullName)}</div>
      <div class="insight-meta">${htmlEscape(room?.name || "Sans classe")}</div>
      <span class="inactive-badge">${lastSeenText}</span>
    </div>`;
  }).join("");
}

function renderClassGauges(filteredStudents) {
  if (!dom.classGauges) return;
  const curriculum = curriculumTotals();
  const classes = getScopedClasses();

  if (!classes.length) {
    dom.classGauges.innerHTML = '<p class="insight-empty">Aucune classe disponible.</p>';
    return;
  }

  dom.classGauges.innerHTML = classes.map((room) => {
    const classStudents = filteredStudents.filter((s) => s.classId === room.id);
    const count = classStudents.length;
    const totalLessons = curriculum.lessons * count;
    const doneLessons = classStudents.reduce((sum, s) => sum + (s.lessonsCompleted || 0), 0);
    const percent = totalLessons > 0 ? Math.min(100, (doneLessons / totalLessons) * 100) : 0;
    const avgGrade = count > 0
      ? (classStudents.reduce((sum, s) => sum + (s.averageQuizGrade || 0), 0) / count).toFixed(1)
      : "—";

    return `<div class="class-gauge">
      <div class="class-gauge-header">
        <strong>${htmlEscape(room.name)}</strong>
        <span class="gauge-meta">${count} étudiant${count !== 1 ? "s" : ""} · Moy. quiz ${avgGrade}/20</span>
      </div>
      <div class="gauge-track"><div class="gauge-fill" style="width:${percent.toFixed(1)}%"></div></div>
      <div class="gauge-label">${doneLessons} / ${totalLessons || 0} leçons · ${percent.toFixed(0)}%</div>
    </div>`;
  }).join("");
}

function renderQuizStruggle(filteredStudents) {
  if (!dom.quizStruggleList) return;

  const byModule = {};
  for (const student of filteredStudents) {
    const scores = student.quizScoresByModule;
    if (!scores || typeof scores !== "object") continue;
    for (const [moduleId, score] of Object.entries(scores)) {
      if (!byModule[moduleId]) byModule[moduleId] = { total: 0, count: 0 };
      byModule[moduleId].total += Number(score);
      byModule[moduleId].count += 1;
    }
  }

  const ranked = Object.entries(byModule)
    .map(([moduleId, { total, count }]) => {
      const avg = total / count;
      const mod = state.modules.find((m) => m.id === moduleId);
      return { name: mod?.name || moduleId, avg, count };
    })
    .sort((a, b) => a.avg - b.avg);

  if (!ranked.length) {
    dom.quizStruggleList.innerHTML = '<p class="insight-empty">Aucune donnée de quiz disponible.</p>';
    return;
  }

  dom.quizStruggleList.innerHTML = ranked.map((entry) => {
    const pct = Math.min(100, (entry.avg / 20) * 100);
    const colorClass = entry.avg < 10 ? "struggle-critical" : entry.avg < 14 ? "struggle-warning" : "struggle-ok";
    return `<div class="struggle-row">
      <div class="struggle-name">${htmlEscape(entry.name)}</div>
      <div class="struggle-bar-wrap">
        <div class="struggle-bar ${colorClass}" style="width:${pct.toFixed(1)}%"></div>
      </div>
      <span class="struggle-score">${entry.avg.toFixed(1)}/20</span>
      <span class="struggle-count">${entry.count} résultat${entry.count !== 1 ? "s" : ""}</span>
    </div>`;
  }).join("");
}

function renderModuleTable(filteredStudents) {
  if (!dom.moduleTableBody) return;

  const modules = state.modules;
  if (!modules.length) {
    dom.moduleTableBody.innerHTML = '<tr><td colspan="5" class="module-table-empty">Aucun module disponible.</td></tr>';
    return;
  }

  dom.moduleTableBody.innerHTML = modules.map((mod) => {
    const acquisCount = Array.isArray(mod.acquis) ? mod.acquis.length : 0;
    const subList = listModuleSousAcquis(mod);
    const sousAcquisCount = subList.length;
    const totalLessons = subList.reduce((sum, e) => sum + (Number(e.subAcquis?.lessonsCount) || 0), 0);
    const totalQuizzes = subList.reduce((sum, e) => sum + (Array.isArray(e.subAcquis?.quizzes) ? e.subAcquis.quizzes.length : 0), 0);

    const scores = filteredStudents
      .map((s) => s.quizScoresByModule?.[mod.id])
      .filter((v) => v !== undefined && v !== null);
    const avgRaw = scores.length > 0
      ? scores.reduce((a, b) => a + Number(b), 0) / scores.length
      : null;
    const avgQuiz = avgRaw !== null ? avgRaw.toFixed(1) + "/20" : "—";
    const avgClass = avgRaw !== null
      ? (avgRaw < 10 ? "mod-pct-low" : avgRaw < 14 ? "mod-pct-warn" : "mod-pct-ok")
      : "";

    return `<tr>
      <td class="mod-name">${htmlEscape(mod.name)}</td>
      <td class="mod-num">${acquisCount}</td>
      <td class="mod-num">${sousAcquisCount}</td>
      <td class="mod-num">${totalLessons}</td>
      <td class="mod-num">${totalQuizzes}</td>
      <td class="mod-num ${avgClass}">${avgQuiz}</td>
    </tr>`;
  }).join("");
}

function buildTable(headers, rows) {
  if (!rows.length) {
    return "<p>Aucune donnée disponible pour ce filtre.</p>";
  }

  const headerHtml = headers.map((header) => `<th>${htmlEscape(header)}</th>`).join("");
  const bodyHtml = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("");

  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

function renderContentTree() {
  if (!dom.contentTree) {
    return;
  }

  const hasApiOverview = Array.isArray(curriculumOverview) && curriculumOverview.length > 0;

  if (!hasApiOverview && !state.modules.length) {
    dom.contentTree.innerHTML = "<p>Aucun module pour le moment.</p>";
    return;
  }

  if (hasApiOverview) {
    dom.contentTree.innerHTML = curriculumOverview
      .map((moduleData) => {
        const moduleId = String(moduleData.id || "");
        const matchingModule = state.modules.find((item) => item.id === moduleId);
        const moduleNameFromFile = curriculumNames.modulesById[moduleId];
        const moduleLabel = moduleNameFromFile || matchingModule?.name || `Module ${moduleId}`;

        const subAcquis = Array.isArray(moduleData.subAcquis) ? moduleData.subAcquis : [];
        const subAcquisHtml = subAcquis.length
          ? subAcquis
              .map((entry) => {
                const subId = String(entry?.id || "");
                const subLabel = curriculumNames.subAcquisById[subId] || subId || "Sous-acquis";

                return `<li><strong>${htmlEscape(subLabel)}</strong></li>`;
              })
              .join("")
          : "<li>Aucun sous-acquis detecte</li>";

        return `<article class="tree-module">
          <h4>${htmlEscape(moduleLabel)}</h4>
          <h5>Sous-acquis</h5>
          <ul>${subAcquisHtml}</ul>
        </article>`;
      })
      .join("");

    return;
  }

  dom.contentTree.innerHTML = state.modules
    .map((module) => {
      const sousAcquisList = listSousAcquisByModule(module.id);
      const sousAcquisHtml = sousAcquisList.length
        ? sousAcquisList
            .map((entry) => {
              const sub = findSousAcquis(module.id, entry.id);
              const quizList = Array.isArray(sub?.quizzes) ? sub.quizzes : [];
              const quizCount = quizList.length;
              const quizTypes = quizList
                .map((quiz) => quiz.type)
                .filter(Boolean)
                .join(", ");
              const bloom = sub?.bloomLevel || "Non precise";
              const resourceType = sub?.resource?.type || "non precise";
              const resourceRef = sub?.resource?.ref || "non precise";

              return `<li>
                <strong>${htmlEscape(sub?.name || entry.name)}</strong><br />
                Bloom: ${htmlEscape(bloom)}<br />
                Support: ${htmlEscape(resourceType)} - ${htmlEscape(resourceRef)}<br />
                Leçons: ${htmlEscape(sub?.lessonsCount || 0)} - Quiz: ${htmlEscape(quizCount)}${
                  quizTypes ? ` (${htmlEscape(quizTypes)})` : ""
                }
              </li>`;
            })
            .join("")
        : "<li>Aucun sous-acquis pour le moment</li>";

      return `<article class="tree-module"><h4>${htmlEscape(module.name)}</h4><ul>${sousAcquisHtml}</ul></article>`;
    })
    .join("");
}

function escapeAttr(value) {
  return htmlEscape(value).replace(/"/g, "&quot;");
}

function listModuleSousAcquis(module) {
  if (!module || !Array.isArray(module.acquis)) return [];
  return module.acquis.flatMap((acquis) =>
    (Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : []).map((subAcquis) => ({
      acquis,
      subAcquis
    }))
  );
}

function insertSubAcquisIntoAcquis(module, acquisId, insertIndex, subAcquis) {
  if (!module || !subAcquis) {
    return;
  }

  const acquis = acquisId ? (module.acquis || []).find((entry) => entry.id === acquisId) : null;
  const targetAcquis = acquis || getOrCreateDefaultAcquis(module);
  if (!Array.isArray(targetAcquis.sousAcquis)) {
    targetAcquis.sousAcquis = [];
  }

  const clampedIndex = Math.max(0, Math.min(insertIndex, targetAcquis.sousAcquis.length));
  targetAcquis.sousAcquis.splice(clampedIndex, 0, subAcquis);
}

function findSubAcquisContext(moduleId, subAcquisId) {
  const module = findModule(moduleId);
  if (!module || !Array.isArray(module.acquis)) return null;

  for (const acquis of module.acquis) {
    const subAcquis = Array.isArray(acquis.sousAcquis)
      ? acquis.sousAcquis.find((entry) => entry.id === subAcquisId)
      : null;

    if (subAcquis) {
      return { module, acquis, subAcquis };
    }
  }

  return null;
}

function renderContentManagementWorkspace() {
  if (!dom.contentManagementList) {
    return;
  }

  if (!state.modules.length) {
    dom.contentManagementList.innerHTML = "<p>Aucun module disponible.</p>";
    return;
  }

  const htmlParts = [];

  state.modules.forEach((module) => {
    htmlParts.push(`
      <article class="module-manage-card">
        <div class="module-manage-head">
          <h4>${htmlEscape(module.name || module.id)}</h4>
          <div class="module-manage-actions">
            <button type="button" class="secondary-btn" data-action="edit-module" data-module-id="${escapeAttr(
              module.id
            )}">Modifier</button>
            <button type="button" class="danger-btn" data-action="delete-module" data-module-id="${escapeAttr(
              module.id
            )}">Supprimer</button>
          </div>
        </div>
      </article>
    `);
  });

  dom.contentManagementList.innerHTML = htmlParts.join("");

  if (contentEditorState.moduleId) {
    openModuleEditor(contentEditorState.moduleId, { silent: true });
  }

  if (contentEditorState.subAcquisId) {
    openSubEditor(contentEditorState.moduleId, contentEditorState.subAcquisId, { silent: true });
  }

  if (Number.isInteger(moduleInsertState.insertIndex)) {
    openInsertModulePage(moduleInsertState.insertIndex, { silent: true });
  }
}

function onContentManagementListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  const moduleId = button.dataset.moduleId || "";
  const subId = button.dataset.subId || "";

  if (action === "insert-sub-at") {
    const insertIndex = Number(button.dataset.subInsertIndex);
    const acquisId = button.dataset.acquisId || contentEditorState.selectedAcquisId;
    openSubInsertEditor(moduleId || contentEditorState.moduleId, acquisId, insertIndex);
    return;
  }

  if (action === "open-acquis") {
    contentEditorState.selectedAcquisId = button.dataset.acquisId || "";
    renderModuleEditorBody(findModule(moduleId || contentEditorState.moduleId));
    return;
  }

  if (action === "back-to-acquis") {
    contentEditorState.selectedAcquisId = "";
    renderModuleEditorBody(findModule(contentEditorState.moduleId));
    return;
  }

  if (action === "insert-acquis-at") {
    acquisRenameState.acquisId = "";
    acquisInsertState.index = Number(button.dataset.insertIndex);
    renderModuleEditorAcquisList(findModule(moduleId));
    return;
  }

  if (action === "cancel-acquis-at") {
    acquisInsertState.index = null;
    renderModuleEditorAcquisList(findModule(moduleId));
    return;
  }

  if (action === "save-acquis-at") {
    const module = findModule(moduleId);
    if (!module) return;
    const input = document.getElementById("new-acquis-name-input");
    const acquisName = String(input?.value || "").trim();
    if (!acquisName) {
      showToast("Saisissez un nom d'acquis");
      return;
    }
    const duplicate = (module.acquis || []).some(
      (entry) => String(entry.name || "").toLowerCase() === acquisName.toLowerCase()
    );
    if (duplicate) {
      showToast("Un acquis avec ce nom existe déjà");
      return;
    }
    if (!Array.isArray(module.acquis)) module.acquis = [];
    const insertIndex = Number.isInteger(acquisInsertState.index)
      ? Math.max(0, Math.min(acquisInsertState.index, module.acquis.length))
      : module.acquis.length;
    module.acquis.splice(insertIndex, 0, { id: uniqueId("acq"), name: acquisName, sousAcquis: [] });
    acquisInsertState.index = null;
    saveState();
    refreshAll();
    renderModuleEditorAcquisList(module);
    showToast("Acquis ajouté");
    return;
  }

  if (action === "rename-acquis") {
    acquisRenameState.acquisId = button.dataset.acquisId || "";
    renderModuleEditorAcquisList(findModule(moduleId));
    return;
  }

  if (action === "cancel-rename-acquis") {
    acquisRenameState.acquisId = "";
    renderModuleEditorAcquisList(findModule(moduleId));
    return;
  }

  if (action === "save-rename-acquis") {
    const module = findModule(moduleId);
    const acquisId = button.dataset.acquisId || "";
    const acquis = module ? (module.acquis || []).find((entry) => entry.id === acquisId) : null;
    if (!module || !acquis) {
      showToast("Acquis introuvable");
      return;
    }
    const input = document.getElementById("acquis-rename-input");
    const newName = String(input?.value || "").trim();
    if (!newName) {
      showToast("Saisissez un nom d'acquis");
      return;
    }
    const duplicate = module.acquis.some(
      (entry) => entry.id !== acquisId && String(entry.name || "").toLowerCase() === newName.toLowerCase()
    );
    if (duplicate) {
      showToast("Un acquis avec ce nom existe déjà");
      return;
    }
    acquis.name = newName;
    acquisRenameState.acquisId = "";
    saveState();
    refreshAll();
    renderModuleEditorAcquisList(module);
    showToast("Acquis modifié");
    return;
  }

  if (action === "delete-acquis") {
    const module = findModule(moduleId);
    const acquisId = button.dataset.acquisId || "";
    const acquis = module ? (module.acquis || []).find((entry) => entry.id === acquisId) : null;
    if (!module || !acquis) {
      showToast("Acquis introuvable");
      return;
    }
    if (!window.confirm(`Supprimer l'acquis "${acquis.name}" et tout son contenu ?`)) return;
    module.acquis = module.acquis.filter((entry) => entry.id !== acquisId);
    if (contentEditorState.selectedAcquisId === acquisId) {
      contentEditorState.selectedAcquisId = "";
    }
    saveState();
    refreshAll();
    renderModuleEditorBody(module);
    showToast("Acquis supprimé");
    return;
  }

  if (action === "edit-module") {
    openModuleEditor(moduleId);
    return;
  }

  if (action === "insert-module-at") {
    const insertIndex = Number(button.dataset.insertIndex);
    openInsertModulePage(insertIndex);
    return;
  }

  if (action === "delete-module") {
    const module = findModule(moduleId);
    if (!module) return;
    if (!window.confirm(`Supprimer le module \"${module.name}\" et tout son contenu ?`)) return;
    state.modules = state.modules.filter((entry) => entry.id !== moduleId);
    closeContentEditors();
    saveState();
    refreshAll();
    showToast("Module supprimé");
    return;
  }

  if (action === "edit-sub") {
    openSubEditor(moduleId, subId);
    return;
  }

  if (action === "delete-sub") {
    const context = findSubAcquisContext(moduleId, subId);
    if (!context) return;
    if (!window.confirm(`Supprimer le sous-acquis \"${context.subAcquis.name}\" ?`)) return;
    context.acquis.sousAcquis = context.acquis.sousAcquis.filter((entry) => entry.id !== subId);
    if (contentEditorState.subAcquisId === subId) {
      contentEditorState.subAcquisId = "";
    }
    saveState();
    refreshAll();
    if (contentEditorState.moduleId === moduleId) {
      renderModuleEditorBody(findModule(moduleId));
    }
    showToast("Sous-acquis supprimé");
  }
}

function closeContentEditors() {
  contentEditorState = { moduleId: "", subAcquisId: "", selectedAcquisId: "" };
  moduleInsertState = { insertIndex: null };
  subInsertState = { index: null, acquisId: "" };
  acquisRenameState = { acquisId: "" };
  acquisInsertState = { index: null };
  resetPendingSubQuizDraft();
  closeSubInsertEditor();
  setModuleWorkspaceMode("list");
}

function openInsertModulePage(insertIndex, options = {}) {
  if (!Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > state.modules.length) {
    if (!options.silent) {
      showToast("Position d'insertion invalide");
    }
    return;
  }

  contentEditorState = { moduleId: "", subAcquisId: "", selectedAcquisId: "" };
  moduleInsertState = {
    insertIndex
  };

  setModuleWorkspaceMode("insert-module");

  if (dom.moduleInsertTitle) {
    if (insertIndex === 0) {
      dom.moduleInsertTitle.textContent = "Ajouter un module au debut";
    } else if (insertIndex >= state.modules.length) {
      dom.moduleInsertTitle.textContent = "Ajouter un module a la fin";
    } else {
      const previousModule = state.modules[insertIndex - 1];
      const nextModule = state.modules[insertIndex];
      dom.moduleInsertTitle.textContent = `Ajouter un module entre ${previousModule?.name || "..."} et ${nextModule?.name || "..."}`;
    }
  }

  if (dom.moduleInsertName) {
    dom.moduleInsertName.value = "";
    if (!options.silent) {
      dom.moduleInsertName.focus();
    }
  }
}

function onInsertModuleAtPosition(event) {
  event.preventDefault();

  if (!Number.isInteger(moduleInsertState.insertIndex)) {
    showToast("Aucune position d'insertion selectionnee");
    return;
  }

  const moduleName = String(dom.moduleInsertName?.value || "").trim();
  if (!moduleName) {
    showToast("Saisissez un nom de module");
    return;
  }

  const insertIndex = moduleInsertState.insertIndex;
  if (insertIndex < 0 || insertIndex > state.modules.length) {
    showToast("Position d'insertion invalide");
    closeContentEditors();
    return;
  }

  state.modules.splice(insertIndex, 0, {
    id: uniqueId("mod"),
    name: moduleName,
    acquis: []
  });

  saveState();
  closeContentEditors();
  refreshAll();
  showToast("Module insere");
}

function openModuleEditor(moduleId, options = {}) {
  const module = findModule(moduleId);
  if (!module) {
    if (!options.silent) showToast("Module introuvable");
    return;
  }

  contentEditorState.moduleId = moduleId;
  contentEditorState.selectedAcquisId = "";
  acquisRenameState.acquisId = "";
  acquisInsertState.index = null;
  subInsertState = { index: null, acquisId: "" };
  closeSubInsertEditor();
  setModuleWorkspaceMode("module-editor");

  if (!options.silent) {
    resetPendingSubQuizDraft();
  }

  dom.moduleEditorTitle.textContent = `Modifier le module: ${module.name}`;
  dom.moduleEditName.value = module.name || "";

  renderModuleEditorBody(module);
}

/**
 * Dispatches the module editor's content pane: the acquis list by default,
 * or a single acquis' sous-acquis once one has been opened.
 */
function renderModuleEditorBody(module) {
  if (!module) return;

  const selectedAcquisId = contentEditorState.selectedAcquisId;
  const selectedAcquis = selectedAcquisId
    ? (module.acquis || []).find((entry) => entry.id === selectedAcquisId)
    : null;

  if (selectedAcquisId && !selectedAcquis) {
    // The previously-open acquis was deleted or renamed away; fall back to the list.
    contentEditorState.selectedAcquisId = "";
    renderModuleEditorAcquisList(module);
    return;
  }

  if (selectedAcquis) {
    renderModuleEditorSubList(module, selectedAcquis);
  } else {
    renderModuleEditorAcquisList(module);
  }
}

function renderModuleEditorAcquisList(module) {
  if (!dom.moduleEditorSubList) return;

  const acquisList = Array.isArray(module.acquis) ? module.acquis : [];

  // An "add acquis" affordance shown between each acquis (and at the ends).
  // Clicking it reveals an inline name input that inserts at that position.
  const insertLine = (index) => {
    if (acquisInsertState.index === index) {
      return `
        <div class="module-editor-sub-row module-editor-add-acquis-row">
          <input type="text" id="new-acquis-name-input" class="acquis-inline-input" placeholder="Nom du nouvel acquis" />
          <span class="module-manage-actions">
            <button type="button" class="secondary-btn" data-action="save-acquis-at" data-module-id="${escapeAttr(
              module.id
            )}" data-insert-index="${index}">Enregistrer</button>
            <button type="button" class="secondary-btn" data-action="cancel-acquis-at" data-module-id="${escapeAttr(
              module.id
            )}">Annuler</button>
          </span>
        </div>
      `;
    }
    return `
      <button type="button" class="module-insert-line" data-action="insert-acquis-at" data-module-id="${escapeAttr(
        module.id
      )}" data-insert-index="${index}" aria-label="Ajouter un acquis à cette position">
        <span class="module-insert-line-mark">+</span>
        <span>Ajouter un acquis</span>
      </button>
    `;
  };

  const parts = [];
  if (!acquisList.length) {
    parts.push('<p class="module-editor-empty">Aucun acquis pour ce module.</p>');
  }
  parts.push(insertLine(0));

  acquisList.forEach((acquis, index) => {
    if (acquisRenameState.acquisId === acquis.id) {
      parts.push(`
        <div class="module-editor-sub-row">
          <input type="text" id="acquis-rename-input" class="acquis-inline-input" value="${escapeAttr(
            acquis.name || ""
          )}" placeholder="Nom de l'acquis" />
          <span class="module-manage-actions">
            <button type="button" class="secondary-btn" data-action="save-rename-acquis" data-module-id="${escapeAttr(
              module.id
            )}" data-acquis-id="${escapeAttr(acquis.id)}">Enregistrer</button>
            <button type="button" class="secondary-btn" data-action="cancel-rename-acquis" data-module-id="${escapeAttr(
              module.id
            )}">Annuler</button>
          </span>
        </div>
      `);
    } else {
      const count = Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis.length : 0;
      parts.push(`
        <div class="module-editor-sub-row">
          <span>${htmlEscape(acquis.name || acquis.id)}<span class="acquis-sub-count"> · ${count} sous-acquis</span></span>
          <span class="module-manage-actions">
            <button type="button" class="secondary-btn" data-action="open-acquis" data-module-id="${escapeAttr(
              module.id
            )}" data-acquis-id="${escapeAttr(acquis.id)}">Ouvrir</button>
            <button type="button" class="secondary-btn" data-action="rename-acquis" data-module-id="${escapeAttr(
              module.id
            )}" data-acquis-id="${escapeAttr(acquis.id)}">Renommer</button>
            <button type="button" class="danger-btn" data-action="delete-acquis" data-module-id="${escapeAttr(
              module.id
            )}" data-acquis-id="${escapeAttr(acquis.id)}">Supprimer</button>
          </span>
        </div>
      `);
    }
    parts.push(insertLine(index + 1));
  });

  dom.moduleEditorSubList.innerHTML = parts.join("");
}

function renderModuleEditorSubList(module, acquis) {
  if (!dom.moduleEditorSubList) return;

  const subItems = Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : [];
  const insertLine = (index) => `
    <button type="button" class="module-insert-line" data-action="insert-sub-at" data-module-id="${escapeAttr(
      module.id
    )}" data-acquis-id="${escapeAttr(acquis.id)}" data-sub-insert-index="${index}" aria-label="Ajouter un sous-acquis à cette position">
      <span class="module-insert-line-mark">+</span>
      <span>Ajouter</span>
    </button>
  `;

  const htmlParts = [
    `<button type="button" class="secondary-btn module-editor-back-btn" data-action="back-to-acquis">← Retour aux acquis</button>`,
    `<h4 class="module-editor-acquis-title">${htmlEscape(acquis.name || acquis.id)}</h4>`,
    insertLine(0)
  ];

  subItems.forEach((subAcquis, index) => {
    htmlParts.push(`
      <div class="module-editor-sub-row">
        <span>${htmlEscape(subAcquis.name || subAcquis.id)}</span>
        <span class="module-manage-actions">
          <button type="button" class="secondary-btn" data-action="edit-sub" data-module-id="${escapeAttr(
            module.id
          )}" data-sub-id="${escapeAttr(subAcquis.id)}">Modifier</button>
          <button type="button" class="danger-btn" data-action="delete-sub" data-module-id="${escapeAttr(
            module.id
          )}" data-sub-id="${escapeAttr(subAcquis.id)}">Supprimer</button>
        </span>
      </div>
    `);
    htmlParts.push(insertLine(index + 1));
  });

  dom.moduleEditorSubList.innerHTML = htmlParts.join("");
}

function openSubInsertEditor(moduleId, acquisId, insertIndex, options = {}) {
  const module = findModule(moduleId);
  if (!module) {
    if (!options.silent) {
      showToast("Module introuvable");
    }
    return;
  }

  const acquis = acquisId ? (module.acquis || []).find((entry) => entry.id === acquisId) : null;
  const subItems = acquis && Array.isArray(acquis.sousAcquis) ? acquis.sousAcquis : [];

  if (!Number.isInteger(insertIndex) || insertIndex < 0 || insertIndex > subItems.length) {
    if (!options.silent) {
      showToast("Position invalide");
    }
    return;
  }

  subInsertState.index = insertIndex;
  subInsertState.acquisId = acquisId || "";

  if (dom.moduleAddSubTitle) {
    if (!subItems.length) {
      dom.moduleAddSubTitle.textContent = "Ajouter un sous-acquis";
    } else if (insertIndex === 0) {
      dom.moduleAddSubTitle.textContent = "Ajouter un sous-acquis au debut";
    } else if (insertIndex === subItems.length) {
      dom.moduleAddSubTitle.textContent = "Ajouter un sous-acquis a la fin";
    } else {
      const previousSub = subItems[insertIndex - 1]?.name || "...";
      const nextSub = subItems[insertIndex]?.name || "...";
      dom.moduleAddSubTitle.textContent = `Ajouter un sous-acquis entre ${previousSub} et ${nextSub}`;
    }
  }

  // Show add form, hide quiz builder within the sub-add view
  const formCard = document.getElementById("sub-add-form-card");
  const quizCard = document.getElementById("sub-quiz-builder-page");
  if (formCard) formCard.hidden = false;
  if (quizCard) quizCard.hidden = true;

  if (!options.silent) {
    dom.moduleAddSubForm?.reset();
    resetPendingSubQuizDraft();
  }

  switchView("sub-add");

  if (!options.silent) {
    dom.moduleAddSubForm?.subName?.focus?.();
  }
}

function closeSubInsertEditor() {
  subInsertState.index = null;
  subInsertState.acquisId = "";
}

function resetPendingSubQuizDraft() {
  pendingSubQuizDraft = createEmptyPendingSubQuiz();
  renderSubQuizOptionInputs(["", ""]);
  renderPendingSubQuizDraft();
}

function getSubQuizOptionValues() {
  if (!dom.subQuizOptionsList) {
    return [];
  }

  return Array.from(dom.subQuizOptionsList.querySelectorAll("input[data-sub-quiz-option-index]"))
    .map((input) => String(input.value || ""));
}

function updateSubQuizCorrectAnswerSelect(optionValues, preferredIndex = 0) {
  if (!dom.subQuizCorrectAnswer) {
    return;
  }

  const safeValues = Array.isArray(optionValues) ? optionValues : [];
  const selectedIndex = Number.isInteger(preferredIndex)
    ? Math.max(0, Math.min(preferredIndex, Math.max(0, safeValues.length - 1)))
    : 0;

  dom.subQuizCorrectAnswer.innerHTML = safeValues
    .map((optionValue, index) => {
      const label = optionValue.trim() || `Option ${index + 1}`;
      const isSelected = index === selectedIndex ? " selected" : "";
      return `<option value="${index}"${isSelected}>${htmlEscape(label)}</option>`;
    })
    .join("");
}

function renderSubQuizOptionInputs(values, preferredIndex = 0) {
  if (!dom.subQuizOptionsList) {
    return;
  }

  const safeValues = Array.isArray(values) ? values.slice() : [];
  while (safeValues.length < MIN_DYNAMIC_QUIZ_OPTIONS) {
    safeValues.push("");
  }

  dom.subQuizOptionsList.innerHTML = safeValues
    .map((value, index) => {
      const removeDisabled = safeValues.length <= MIN_DYNAMIC_QUIZ_OPTIONS ? " disabled" : "";
      return `
        <label>
          Option ${index + 1}
          <input type="text" data-sub-quiz-option-index="${index}" value="${escapeAttr(value)}" />
        </label>
        <div class="button-row">
          <button type="button" class="secondary-btn" data-action="remove-sub-quiz-option" data-option-index="${index}"${removeDisabled}>Supprimer option</button>
        </div>
      `;
    })
    .join("");

  updateSubQuizCorrectAnswerSelect(safeValues, preferredIndex);
}

function onAddSubQuizOptionField() {
  const values = getSubQuizOptionValues();
  values.push("");
  const selected = Number(dom.subQuizCorrectAnswer?.value || 0);
  renderSubQuizOptionInputs(values, selected);
}

function onSubQuizOptionsListClick(event) {
  const button = event.target.closest("button[data-action='remove-sub-quiz-option']");
  if (!button) {
    return;
  }

  const values = getSubQuizOptionValues();
  if (values.length <= MIN_DYNAMIC_QUIZ_OPTIONS) {
    showToast("Au moins deux options sont requises");
    return;
  }

  const optionIndex = Number(button.dataset.optionIndex);
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= values.length) {
    return;
  }

  const previousSelected = Number(dom.subQuizCorrectAnswer?.value || 0);
  values.splice(optionIndex, 1);
  const nextSelected = Math.max(0, Math.min(previousSelected, values.length - 1));
  renderSubQuizOptionInputs(values, nextSelected);
}

function onSubQuizOptionsListInput() {
  const values = getSubQuizOptionValues();
  const selected = Number(dom.subQuizCorrectAnswer?.value || 0);
  updateSubQuizCorrectAnswerSelect(values, selected);
}

function renderPendingSubQuizDraft() {
  if (dom.subQuizTitle) {
    dom.subQuizTitle.value = pendingSubQuizDraft.title || "";
  }
  if (dom.subQuizType) {
    dom.subQuizType.value = pendingSubQuizDraft.type || "qcm";
  }

  if (dom.subQuizDraftList) {
    if (!pendingSubQuizDraft.questions.length) {
      dom.subQuizDraftList.innerHTML = "<li>Aucune question ajoutee.</li>";
    } else {
      dom.subQuizDraftList.innerHTML = pendingSubQuizDraft.questions
        .map(
          (question, index) => `
            <li>
              <strong>Q${index + 1}:</strong> ${htmlEscape(question.prompt || "")}
              <button type="button" class="danger-btn" data-action="remove-pending-sub-quiz-question" data-question-index="${index}">Supprimer</button>
            </li>
          `
        )
        .join("");
    }

    dom.subQuizDraftList.querySelectorAll("button[data-action='remove-pending-sub-quiz-question']").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.questionIndex || -1);
        if (index < 0 || index >= pendingSubQuizDraft.questions.length) return;
        pendingSubQuizDraft.questions.splice(index, 1);
        renderPendingSubQuizDraft();
      });
    });
  }

  const hasQuiz = Boolean((pendingSubQuizDraft.title || "").trim()) || pendingSubQuizDraft.questions.length > 0;
  if (dom.subQuizBuilderStatus) {
    dom.subQuizBuilderStatus.textContent = hasQuiz
      ? `${pendingSubQuizDraft.questions.length} question(s) prêtes pour le quiz.`
      : "Aucun quiz configure.";
  }
}

function openSubQuizBuilderPage() {
  if (!Number.isInteger(subInsertState.index)) {
    showToast("Choisissez d'abord une position d'ajout de sous-acquis");
    return;
  }

  const formCard = document.getElementById("sub-add-form-card");
  const quizCard = document.getElementById("sub-quiz-builder-page");
  if (formCard) formCard.hidden = true;
  if (quizCard) quizCard.hidden = false;

  renderPendingSubQuizDraft();
}

function onBackToModuleAddSubForm() {
  pendingSubQuizDraft.title = String(dom.subQuizTitle?.value || "").trim();
  pendingSubQuizDraft.type = String(dom.subQuizType?.value || "qcm");

  const formCard = document.getElementById("sub-add-form-card");
  const quizCard = document.getElementById("sub-quiz-builder-page");
  if (formCard) formCard.hidden = false;
  if (quizCard) quizCard.hidden = true;

  renderPendingSubQuizDraft();
}

function onAddQuestionToPendingSubQuiz() {
  const prompt = String(dom.subQuizQuestion?.value || "").trim();
  const options = getSubQuizOptionValues().map((value) => String(value || "").trim());
  const correctAnswerIndex = Number(dom.subQuizCorrectAnswer?.value || 0);

  if (!prompt || options.length < MIN_DYNAMIC_QUIZ_OPTIONS || options.some((option) => !option)) {
    showToast("Saisissez la question et toutes les options");
    return;
  }

  pendingSubQuizDraft.title = String(dom.subQuizTitle?.value || "").trim();
  pendingSubQuizDraft.type = String(dom.subQuizType?.value || "qcm");
  pendingSubQuizDraft.questions.push({
    prompt,
    options,
    correctAnswerIndex
  });

  if (dom.subQuizQuestion) dom.subQuizQuestion.value = "";
  renderSubQuizOptionInputs(["", ""], 0);

  renderPendingSubQuizDraft();
  showToast("Question ajoutee");
}

function onClearPendingSubQuiz() {
  resetPendingSubQuizDraft();

  if (dom.subQuizQuestion) dom.subQuizQuestion.value = "";
  renderSubQuizOptionInputs(["", ""], 0);

  showToast("Quiz efface");
}

function onSaveModuleEditor(event) {
  event.preventDefault();
  const module = findModule(contentEditorState.moduleId);
  if (!module) return;

  const nextName = String(dom.moduleEditName.value || "").trim();
  if (!nextName) {
    showToast("Saisissez un nom de module");
    return;
  }

  module.name = nextName;
  saveState();
  refreshAll();
  showToast("Module modifie");
}

function onDeleteModuleFromEditor() {
  const module = findModule(contentEditorState.moduleId);
  if (!module) return;
  if (!window.confirm(`Supprimer le module \"${module.name}\" et tout son contenu ?`)) return;

  state.modules = state.modules.filter((entry) => entry.id !== module.id);
  closeContentEditors();
  saveState();
  refreshAll();
  showToast("Module supprimé");
}

async function onAddSubFromModuleEditor(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const module = findModule(contentEditorState.moduleId);
  if (!module) {
    showToast("Module introuvable");
    return;
  }

  const subName = form.subName.value.trim();
  const bloomLevel = form.bloomLevel.value;
  const lessonsCount = Number(form.lessonsCount.value || 1);
  const videoUrl = String(form.videoUrl.value || "").trim();
  const selectedFiles = form.resourceFile.files ? Array.from(form.resourceFile.files) : [];

  const quizTitle = String(pendingSubQuizDraft.title || "").trim();
  const quizType = String(pendingSubQuizDraft.type || "qcm");
  const quizQuestions = Array.isArray(pendingSubQuizDraft.questions)
    ? pendingSubQuizDraft.questions.map((question) => ({ ...question }))
    : [];

  if (quizQuestions.length && !quizTitle) {
    showToast("Ajoutez un titre au quiz dans la page de configuration");
    return;
  }

  if (!subName || !bloomLevel || !selectedFiles.length) {
    showToast("Nom, niveau Bloom et au moins un support sont obligatoires");
    return;
  }

  for (const file of selectedFiles) {
    const lowerName = file.name.toLowerCase();
    const isPdf = lowerName.endsWith(".pdf") || file.type === "application/pdf";
    const isPpt =
      lowerName.endsWith(".ppt") ||
      lowerName.endsWith(".pptx") ||
      file.type === "application/vnd.ms-powerpoint" ||
      file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    if (!isPdf && !isPpt) {
      showToast(`Fichier invalide : ${file.name}. Utilisez PDF ou PowerPoint.`);
      return;
    }
  }

  const subAcquisId = uniqueId("sacq");

  try {
    const courseFiles = [];
    for (const file of selectedFiles) {
      const uploadResult = await uploadCourseResource({ moduleId: module.id, subAcquisId, file });
      const publicUrl = uploadResult?.publicUrl;
      if (!publicUrl) throw new Error("URL publique introuvable");
      courseFiles.push({
        id: uniqueId("course"),
        title: file.name,
        url: publicUrl,
        fileType: "pdf"
      });
    }

    const subAcquis = {
      id: subAcquisId,
      name: subName,
      bloomLevel,
      resource: { type: "pdf", ref: courseFiles[0].url },
      lessonsCount: Math.max(1, lessonsCount),
      courseFiles,
      videos: videoUrl
        ? [
            {
              id: uniqueId("video"),
              title: `Video ${subName}`,
              url: videoUrl,
              source: "external"
            }
          ]
        : [],
      quizzes: []
    };

    if (quizTitle) {
      subAcquis.quizzes.push({
        id: uniqueId("quiz"),
        type: quizType,
        title: quizTitle,
        questions: quizQuestions
      });
    }

    const insertIndex = Number.isInteger(subInsertState.index) ? Number(subInsertState.index) : 0;

    insertSubAcquisIntoAcquis(module, subInsertState.acquisId, insertIndex, subAcquis);

    form.reset();
    closeSubInsertEditor();
    resetPendingSubQuizDraft();
    saveState();
    refreshAll();
    showToast("Sous-acquis ajoute");
    switchView("content");
  } catch (error) {
    console.error("Add sub from editor failed:", error);
    showToast("Echec de l'upload ou de la creation du sous-acquis");
  }
}

function openSubEditor(moduleId, subAcquisId, options = {}) {
  const context = findSubAcquisContext(moduleId, subAcquisId);
  if (!context) {
    if (!options.silent) showToast("Sous-acquis introuvable");
    return;
  }

  contentEditorState.moduleId = moduleId;
  contentEditorState.subAcquisId = subAcquisId;

  switchView("sub-editor");

  dom.subEditorTitle.textContent = `Modifier: ${context.subAcquis.name || context.subAcquis.id}`;
  dom.subEditName.value = context.subAcquis.name || "";
  dom.subEditBloom.value = context.subAcquis.bloomLevel || "";
  dom.subEditLessons.value = Number(context.subAcquis.lessonsCount || 0);
  dom.subEditVideoUrl.value = Array.isArray(context.subAcquis.videos) && context.subAcquis.videos[0]
    ? context.subAcquis.videos[0].url || ""
    : "";

  const quizzes = Array.isArray(context.subAcquis.quizzes) ? context.subAcquis.quizzes : [];
  const optionsMarkup = ['<option value="__new__">Nouveau quiz</option>']
    .concat(
      quizzes.map(
        (quiz) => `<option value="${escapeAttr(quiz.id)}">${htmlEscape(quiz.title || quiz.id)}</option>`
      )
    )
    .join("");

  dom.subEditQuizSelect.innerHTML = optionsMarkup;
  dom.subEditQuizSelect.value = quizzes[0] ? quizzes[0].id : "__new__";
  populateSubEditorQuizFields();

  subEditorPendingDeleteIds = new Set();
  if (dom.subEditResourceFile) dom.subEditResourceFile.value = "";
  renderSubEditorExistingFiles(Array.isArray(context.subAcquis.courseFiles) ? context.subAcquis.courseFiles : []);
}

function renderSubEditorExistingFiles(courseFiles) {
  if (!dom.subEditExistingFiles) return;
  const visible = (courseFiles || []).filter((f) => !subEditorPendingDeleteIds.has(f.id));
  if (!visible.length) {
    dom.subEditExistingFiles.innerHTML = '<span class="no-files-hint">Aucun support enregistré.</span>';
    return;
  }
  dom.subEditExistingFiles.innerHTML = visible.map((f) => `
    <div class="existing-file-chip">
      <span class="existing-file-name" title="${escapeAttr(f.url)}">${htmlEscape(f.title || f.url)}</span>
      <button type="button" class="existing-file-delete" data-file-id="${escapeAttr(f.id)}" aria-label="Supprimer ce fichier">×</button>
    </div>
  `).join("");
}

function onBackToModuleEditor() {
  contentEditorState.subAcquisId = "";
  switchView("content");
}

function populateSubEditorQuizFields() {
  const context = findSubAcquisContext(contentEditorState.moduleId, contentEditorState.subAcquisId);
  if (!context) return;

  const quizzes = Array.isArray(context.subAcquis.quizzes) ? context.subAcquis.quizzes : [];
  const quizId = dom.subEditQuizSelect.value;
  const quiz = quizzes.find((entry) => entry.id === quizId);

  if (!quiz) {
    dom.subEditQuizTitle.value = "";
    dom.subEditQuizType.value = "qcm";
    dom.subEditQuizQuestions.value = "[]";
    return;
  }

  dom.subEditQuizTitle.value = quiz.title || "";
  dom.subEditQuizType.value = quiz.type || "qcm";
  dom.subEditQuizQuestions.value = JSON.stringify(Array.isArray(quiz.questions) ? quiz.questions : [], null, 2);
}

async function onSaveSubEditor(event) {
  event.preventDefault();
  const context = findSubAcquisContext(contentEditorState.moduleId, contentEditorState.subAcquisId);
  if (!context) {
    showToast("Sous-acquis introuvable");
    return;
  }

  const nextName = String(dom.subEditName.value || "").trim();
  const nextBloom = String(dom.subEditBloom.value || "");
  const nextLessons = Number(dom.subEditLessons.value || 0);
  const videoUrl = String(dom.subEditVideoUrl.value || "").trim();

  if (!nextName || !nextBloom) {
    showToast("Nom et niveau Bloom sont obligatoires");
    return;
  }

  context.subAcquis.name = nextName;
  context.subAcquis.bloomLevel = nextBloom;
  context.subAcquis.lessonsCount = Math.max(0, nextLessons);

  if (!Array.isArray(context.subAcquis.videos)) {
    context.subAcquis.videos = [];
  }

  if (videoUrl) {
    context.subAcquis.videos = [
      {
        id: context.subAcquis.videos[0]?.id || uniqueId("video"),
        title: context.subAcquis.videos[0]?.title || `Video ${nextName}`,
        url: videoUrl,
        source: "external"
      }
    ];
  } else {
    context.subAcquis.videos = [];
  }

  if (!Array.isArray(context.subAcquis.courseFiles)) {
    context.subAcquis.courseFiles = [];
  }
  context.subAcquis.courseFiles = context.subAcquis.courseFiles.filter(
    (f) => !subEditorPendingDeleteIds.has(f.id)
  );

  const newFiles = dom.subEditResourceFile.files ? Array.from(dom.subEditResourceFile.files) : [];
  for (const file of newFiles) {
    try {
      const uploadResult = await uploadCourseResource({
        moduleId: context.module.id,
        subAcquisId: context.subAcquis.id,
        file
      });
      const publicUrl = uploadResult?.publicUrl;
      if (!publicUrl) throw new Error("URL publique introuvable");
      context.subAcquis.courseFiles.push({
        id: uniqueId("course"),
        title: file.name,
        url: publicUrl,
        fileType: "pdf"
      });
    } catch (error) {
      console.error("Upload failed:", file.name, error);
      showToast(`Echec de l'upload : ${file.name}`);
      return;
    }
  }

  const firstFile = context.subAcquis.courseFiles[0];
  context.subAcquis.resource = firstFile
    ? { type: "pdf", ref: firstFile.url }
    : { type: "", ref: "" };

  if (!Array.isArray(context.subAcquis.quizzes)) {
    context.subAcquis.quizzes = [];
  }

  const quizId = String(dom.subEditQuizSelect.value || "__new__");
  const quizTitle = String(dom.subEditQuizTitle.value || "").trim();
  const quizType = String(dom.subEditQuizType.value || "qcm");
  const questionsRaw = String(dom.subEditQuizQuestions.value || "[]").trim();

  if (quizTitle) {
    let parsedQuestions = [];
    try {
      const candidate = JSON.parse(questionsRaw || "[]");
      if (!Array.isArray(candidate)) {
        throw new Error("questions-not-array");
      }

      parsedQuestions = candidate.map((question) => ({
        prompt: String(question?.prompt || "").trim(),
        options: Array.isArray(question?.options)
          ? question.options.map((option) => String(option || "").trim()).filter(Boolean)
          : [],
        correctAnswerIndex:
          typeof question?.correctAnswerIndex === "number" ? question.correctAnswerIndex : 0
      }));
    } catch (_error) {
      showToast("Le JSON des questions est invalide");
      return;
    }

    const existingQuiz = context.subAcquis.quizzes.find((entry) => entry.id === quizId);
    if (existingQuiz) {
      existingQuiz.title = quizTitle;
      existingQuiz.type = quizType;
      existingQuiz.questions = parsedQuestions;
    } else {
      context.subAcquis.quizzes.push({
        id: uniqueId("quiz"),
        title: quizTitle,
        type: quizType,
        questions: parsedQuestions
      });
    }
  }

  dom.subEditResourceFile.value = "";
  saveState();
  refreshAll();
  showToast("Sous-acquis mis a jour");
  switchView("content");
}

function onDeleteSubFromEditor() {
  const context = findSubAcquisContext(contentEditorState.moduleId, contentEditorState.subAcquisId);
  if (!context) return;

  if (!window.confirm(`Supprimer le sous-acquis \"${context.subAcquis.name}\" ?`)) {
    return;
  }

  context.acquis.sousAcquis = context.acquis.sousAcquis.filter(
    (entry) => entry.id !== context.subAcquis.id
  );
  contentEditorState.subAcquisId = "";
  saveState();
  refreshAll();
  showToast("Sous-acquis supprimé");
  switchView("content");
}

function renderDraftQuestions() {
  if (!dom.draftQuestions) {
    return;
  }

  if (!draftQuestions.length) {
    dom.draftQuestions.innerHTML = "<li>Aucune question en brouillon.</li>";
    return;
  }

  dom.draftQuestions.innerHTML = draftQuestions
    .map((question, index) => {
      const answerLabel = ["A", "B", "C", "D"][question.correctAnswerIndex] || "?";
      return `<li><strong>Q${index + 1}:</strong> ${htmlEscape(question.prompt)} (bonne reponse: ${answerLabel})</li>`;
    })
    .join("");
}

function renderTeachersTable() {
  const rows = state.teachers.map((teacher) => {
    const classesCount = state.classes.filter((room) => room.teacherId === teacher.id).length;
    return [
      teacher.name,
      teacher.email || "Non renseigne",
      teacher.phone || "Non renseigne",
      classesCount,
      `<span class="module-manage-actions">
        <button type="button" class="secondary-btn" data-action="edit-teacher" data-teacher-id="${escapeAttr(
          teacher.id
        )}">Modifier</button>
        <button type="button" class="danger-btn" data-action="delete-teacher" data-teacher-id="${escapeAttr(
          teacher.id
        )}">Supprimer</button>
      </span>`
    ];
  });

  dom.teacherTable.innerHTML = buildTable(
    ["Enseignant", "Email", "Telephone", "Nombre de classes", "Actions"],
    rows
  );
}

function resetTeacherFormMode() {
  teacherEditState.teacherId = "";
  if (dom.teacherFormTitle) {
    dom.teacherFormTitle.textContent = "Ajouter un enseignant";
  }
  if (dom.teacherSubmitBtn) {
    dom.teacherSubmitBtn.textContent = "Ajouter l'enseignant";
  }
  if (dom.teacherCancelEdit) {
    dom.teacherCancelEdit.hidden = true;
  }

  if (dom.teacherForm) {
    dom.teacherForm.reset();
    if (dom.teacherForm.teacherPassword) {
      dom.teacherForm.teacherPassword.required = true;
      dom.teacherForm.teacherPassword.placeholder = "Minimum 6 caractères";
    }
  }
}

function startTeacherEdit(teacherId) {
  const teacher = state.teachers.find((entry) => entry.id === teacherId);
  if (!teacher || !dom.teacherForm) {
    showToast("Enseignant introuvable");
    return;
  }

  teacherEditState.teacherId = teacherId;
  if (dom.teacherFormTitle) {
    dom.teacherFormTitle.textContent = `Modifier l'enseignant: ${teacher.name}`;
  }
  if (dom.teacherSubmitBtn) {
    dom.teacherSubmitBtn.textContent = "Enregistrer les modifications";
  }
  if (dom.teacherCancelEdit) {
    dom.teacherCancelEdit.hidden = false;
  }

  dom.teacherForm.teacherFullName.value = teacher.name || "";
  dom.teacherForm.teacherEmail.value = teacher.email || "";
  dom.teacherForm.teacherPhone.value = teacher.phone || "";
  dom.teacherForm.teacherPassword.value = "";
  dom.teacherForm.teacherPassword.required = false;
  dom.teacherForm.teacherPassword.placeholder = "Laisser vide pour conserver le mot de passe";
}

async function onTeacherTableClick(event) {
  const button = event.target.closest("button[data-action][data-teacher-id]");
  if (!button) {
    return;
  }

  const action = String(button.dataset.action || "");
  const teacherId = String(button.dataset.teacherId || "");
  if (!teacherId) {
    return;
  }

  if (action === "edit-teacher") {
    startTeacherEdit(teacherId);
    return;
  }

  if (action !== "delete-teacher") {
    return;
  }

  const teacher = state.teachers.find((entry) => entry.id === teacherId);
  if (!teacher) {
    return;
  }

  if (!window.confirm(`Supprimer l'enseignant \"${teacher.name}\" ?`)) {
    return;
  }

  let deletedViaApi = false;
  try {
    const response = await fetch(`/api/backoffice/teachers/${encodeURIComponent(teacherId)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      const apiMessage = await parseApiError(response, "Impossible de supprimer l'enseignant");
      if (response.status === 404 && /route not found/i.test(apiMessage)) {
        deletedViaApi = false;
      } else {
        showToast(apiMessage);
        return;
      }
    } else {
      deletedViaApi = true;
    }
  } catch (_error) {
    deletedViaApi = false;
  }

  state.teachers = state.teachers.filter((entry) => entry.id !== teacherId);
  if (teacherEditState.teacherId === teacherId) {
    resetTeacherFormMode();
  }

  saveState();
  refreshAll();
  showToast(deletedViaApi ? "Enseignant supprime" : "Enseignant supprime localement (backend a redemarrer)");
}

function renderClassesTable() {
  if (!dom.classTable) return;
  const classes = getScopedClasses();
  if (!classes.length) {
    dom.classTable.innerHTML = '<p class="empty-state">Aucune classe créée.</p>';
    return;
  }
  dom.classTable.innerHTML = classes.map((room) => {
    const students = state.students.filter((s) => s.classId === room.id);
    const teacher = htmlEscape(getTeacherNameByClass(room));
    const count = students.length;
    return `<div class="class-overview-card">
      <div class="class-card-head">
        <span class="class-card-name">${htmlEscape(room.name)}</span>
        <span class="class-card-badge">${count} étudiant${count !== 1 ? "s" : ""}</span>
      </div>
      <p class="class-card-teacher">Enseignant : ${teacher}</p>
      <button type="button" class="secondary-btn class-card-btn" data-action="open-class-detail" data-class-id="${escapeAttr(room.id)}">
        Gérer les étudiants →
      </button>
    </div>`;
  }).join("");
}

function onClassTableClick(event) {
  const button = event.target.closest("button[data-action='open-class-detail']");
  if (!button) return;
  const classId = String(button.dataset.classId || "");
  if (classId) openClassDetail(classId);
}

function openClassDetail(classId) {
  const room = state.classes.find((c) => c.id === classId);
  if (!room) return;
  selectedClassId = classId;
  if (dom.classDetailName) dom.classDetailName.textContent = room.name;
  if (dom.classDetailTeacher) dom.classDetailTeacher.textContent = "Enseignant : " + getTeacherNameByClass(room);
  renderClassDetailStudents();
  dom.navItems.forEach((item) => item.classList.toggle("active", item.dataset.view === "classes-create"));
  Object.entries(dom.views).forEach(([key, node]) => node.classList.toggle("active", key === "classes-detail"));
  if (dom.panelEyebrow) dom.panelEyebrow.textContent = "Classe · " + room.name;
  if (dom.panelTitle) dom.panelTitle.textContent = "";
}

function renderClassDetailStudents() {
  if (!selectedClassId || !dom.classDetailStudentTable) return;
  const students = state.students.filter((s) => s.classId === selectedClassId);
  if (!students.length) {
    dom.classDetailStudentTable.innerHTML = '<p class="empty-state">Aucun étudiant dans cette classe.</p>';
    return;
  }
  const rows = students.map((student) => [
    htmlEscape(student.fullName),
    htmlEscape(student.identifier || "Non défini"),
    htmlEscape(student.email || "Non renseigné"),
    `<span class="module-manage-actions">
      <button type="button" class="secondary-btn" data-action="edit-student" data-student-id="${escapeAttr(student.id)}">Modifier</button>
      <button type="button" class="danger-btn" data-action="delete-student" data-student-id="${escapeAttr(student.id)}">Supprimer</button>
    </span>`
  ]);
  dom.classDetailStudentTable.innerHTML = buildTable(
    ["Étudiant", "Identifiant", "Email", "Actions"],
    rows
  );
}

function renderClassAccessTable() {
  if (!dom.classAccessTable) {
    return;
  }

  const rows = state.classes.map((room) => {
    const schedule = room.accessScheduleBySubAcquis && typeof room.accessScheduleBySubAcquis === "object"
      ? room.accessScheduleBySubAcquis
      : {};

    const scheduleDates = Object.values(schedule)
      .map((isoValue) => new Date(String(isoValue || "")))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());

    const now = Date.now();
    const unlockedCount = scheduleDates.filter((date) => date.getTime() <= now).length;
    const upcoming = scheduleDates.find((date) => date.getTime() > now) || null;

    // Modules read as chips rather than a run of <br />-separated names: the
    // granted/blocked state is then visible without reading the column header.
    const moduleChips = (rule, className) => {
      const names = state.modules
        .filter((module) => (room.accessByModule?.[module.id] || "blocked") === rule)
        .map((module) => `<span class="access-chip ${className}">${htmlEscape(module.name)}</span>`);
      return names.length ? `<div class="access-chips">${names.join("")}</div>` : null;
    };

    return [
      `<strong>${htmlEscape(room.name)}</strong>`,
      room.scheduleStartDate
        ? htmlEscape(formatIsoDateLabel(room.scheduleStartDate))
        : `<span class="access-empty">${boTr("bo.notSet", "Non défini")}</span>`,
      scheduleDates.length
        ? `${unlockedCount}/${scheduleDates.length} ${boTr("bo.unlocked", "débloqués")}${
            upcoming
              ? `<br /><span class="access-muted">${boTr("bo.next", "prochain")} : ${htmlEscape(
                  formatIsoDateLabel(upcoming.toISOString())
                )}</span>`
              : ""
          }`
        : `<span class="access-empty">${boTr("bo.noCalendar", "Aucun calendrier généré")}</span>`,
      moduleChips("granted", "access-chip-granted") ||
        `<span class="access-empty">${boTr("bo.noGranted", "Aucun module autorisé")}</span>`,
      moduleChips("blocked", "access-chip-blocked") ||
        `<span class="access-empty">${boTr("bo.noBlocked", "Aucun module bloqué")}</span>`
    ];
  });

  dom.classAccessTable.innerHTML = buildTable(
    [
      boTr("bo.classLabel", "Classe"),
      boTr("bo.startDate", "Date de démarrage"),
      boTr("bo.subAcquisUnlocked", "Sous-acquis débloqués"),
      boTr("bo.grantedModules", "Modules autorisés"),
      boTr("bo.blockedModules", "Modules bloqués")
    ],
    rows
  );
}

function renderStudentsTable() {
  const normalizedSearch = String(studentSearchTerm || "").trim().toLowerCase();

  const rows = state.students
    .filter((student) => {
      if (!normalizedSearch) {
        return true;
      }

      const room = state.classes.find((item) => item.id === student.classId);
      const haystack = [
        student.fullName,
        student.identifier,
        student.email,
        room?.name,
        room ? getTeacherNameByClass(room) : ""
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      return haystack.includes(normalizedSearch);
    })
    .map((student) => {
    const room = state.classes.find((item) => item.id === student.classId);
    return [
      student.fullName,
      student.identifier || "Non defini",
        student.email || "Non renseigne",
      room ? room.name : "Aucune classe",
        room ? getTeacherNameByClass(room) : "Enseignant non assigné",
        `<span class="module-manage-actions">
          <button type="button" class="secondary-btn" data-action="edit-student" data-student-id="${escapeAttr(
            student.id
          )}">Modifier</button>
          <button type="button" class="danger-btn" data-action="delete-student" data-student-id="${escapeAttr(
            student.id
          )}">Supprimer</button>
        </span>`
      ];
    });

  dom.studentTable.innerHTML = buildTable(
    ["Étudiant", "Identifiant", "Email", "Classe", "Enseignant", "Actions"],
    rows
  );
}

function onStudentSearchInput(event) {
  studentSearchTerm = String(event.target?.value || "");
  renderStudentsTable();
}

function resetStudentFormMode() {
  studentEditState.studentId = "";
  if (dom.studentFormTitle) {
    dom.studentFormTitle.textContent = "Ajouter un étudiant à la classe";
  }
  if (dom.studentSubmitBtn) {
    dom.studentSubmitBtn.textContent = "Ajouter l'étudiant";
  }
  if (dom.studentCancelEdit) {
    dom.studentCancelEdit.hidden = true;
  }

  if (dom.studentForm) {
    dom.studentForm.reset();
    if (dom.studentForm.studentPassword) {
      dom.studentForm.studentPassword.required = true;
      dom.studentForm.studentPassword.placeholder = "Minimum 6 caractères";
    }
  }
}

function startStudentEdit(studentId) {
  const student = state.students.find((entry) => entry.id === studentId);
  if (!student || !dom.studentForm) {
    showToast("Étudiant introuvable");
    return;
  }

  openStudentModal("single");
  studentEditState.studentId = studentId;
  if (dom.studentFormTitle) {
    dom.studentFormTitle.textContent = `Modifier l'étudiant : ${student.fullName}`;
  }
  if (dom.studentSubmitBtn) {
    dom.studentSubmitBtn.textContent = "Enregistrer les modifications";
  }
  if (dom.studentCancelEdit) {
    dom.studentCancelEdit.hidden = false;
  }

  dom.studentForm.studentName.value = student.fullName || "";
  dom.studentForm.studentEmail.value = student.email || "";
  dom.studentForm.studentIdentifier.value = student.identifier || "";
  dom.studentForm.studentPassword.value = "";
  dom.studentForm.studentPassword.required = false;
  dom.studentForm.studentPassword.placeholder = "Laisser vide pour conserver le mot de passe";
  dom.studentForm.classId.value = student.classId || "";
}

async function onStudentTableClick(event) {
  const button = event.target.closest("button[data-action][data-student-id]");
  if (!button) {
    return;
  }

  const action = String(button.dataset.action || "");
  const studentId = String(button.dataset.studentId || "");
  if (!studentId) {
    return;
  }

  if (action === "edit-student") {
    startStudentEdit(studentId);
    return;
  }

  if (action !== "delete-student") {
    return;
  }

  const student = state.students.find((entry) => entry.id === studentId);
  if (!student) {
    return;
  }

  if (!window.confirm(`Supprimer l'étudiant \"${student.fullName}\" ?`)) {
    return;
  }

  try {
    const response = await fetch(`/api/backoffice/students/${encodeURIComponent(studentId)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      showToast(await parseApiError(response, "Impossible de supprimer l'étudiant"));
      return;
    }
  } catch (_error) {
    showToast("Connexion serveur indisponible");
    return;
  }

  state.students = state.students.filter((entry) => entry.id !== studentId);
  if (studentEditState.studentId === studentId) {
    resetStudentFormMode();
  }

  saveState();
  refreshAll();
  showToast("Étudiant supprimé");
}

function onAddModule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const moduleName = form.moduleName.value.trim();

  if (!moduleName) return;

  state.modules.push({
    id: uniqueId("mod"),
    name: moduleName,
    acquis: []
  });

  form.reset();
  saveState();
  refreshAll();
  showToast("Module cree");
}

function onAddAcquis(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const moduleId = form.moduleId.value;
  const acquisName = form.acquisName.value.trim();

  if (!moduleId || !acquisName) return;

  const module = findModule(moduleId);
  if (!module) {
    showToast("Selectionnez un module valide");
    return;
  }

  module.acquis.push({
    id: uniqueId("acq"),
    name: acquisName,
    sousAcquis: []
  });

  form.reset();
  saveState();
  refreshAll();
  showToast("Acquis ajoute");
}

function onAddSousAcquis(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const moduleId = form.moduleId.value;
  const sousAcquisName = form.sousAcquisName.value.trim();
  const bloomLevel = form.bloomLevel.value;
  const resourceType = form.resourceType.value;
  const selectedFile = form.resourceFile.files && form.resourceFile.files[0];
  const lessonsCount = Number(form.lessonsCount.value || 1);

  if (!moduleId || !sousAcquisName || !bloomLevel || !resourceType || !selectedFile) {
    showToast("Completez le module, le sous-acquis et le fichier support");
    return;
  }

  const lowerName = selectedFile.name.toLowerCase();
  const isPdfFile = lowerName.endsWith(".pdf") || selectedFile.type === "application/pdf";
  const isPowerPointFile =
    lowerName.endsWith(".ppt") ||
    lowerName.endsWith(".pptx") ||
    selectedFile.type === "application/vnd.ms-powerpoint" ||
    selectedFile.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation";

  if (resourceType === "pdf" && !isPdfFile) {
    showToast("Selectionnez un fichier PDF valide");
    return;
  }

  if (resourceType === "powerpoint" && !isPowerPointFile) {
    showToast("Selectionnez un fichier PowerPoint valide (.ppt ou .pptx)");
    return;
  }

  let module = findModule(moduleId);
  if (!module) {
    const moduleNameFromFile = curriculumNames.modulesById[moduleId] || `Module ${moduleId}`;
    module = {
      id: moduleId,
      name: moduleNameFromFile,
      acquis: []
    };
    state.modules.push(module);
  }

  const acquis = getOrCreateDefaultAcquis(module);
  const subAcquisId = uniqueId("sacq");

  uploadCourseResource({ moduleId, subAcquisId, file: selectedFile })
    .then((uploadResult) => {
      const publicUrl = uploadResult?.publicUrl;

      if (!publicUrl) {
        throw new Error("URL publique introuvable");
      }

      acquis.sousAcquis.push({
        id: subAcquisId,
        name: sousAcquisName,
        bloomLevel,
        resource: {
          type: "pdf",
          ref: publicUrl
        },
        lessonsCount: Math.max(1, lessonsCount),
        quizzes: []
      });

      form.reset();
      saveState();
      refreshAll();
      showToast("Sous-acquis ajoute et support PDF publie");
    })
    .catch((error) => {
      console.error("Course upload error:", error);
      showToast("Echec de l'upload ou de la conversion du support");
    });
}

function onAddDraftQuestion() {
  const form = dom.quizForm;
  const prompt = form.questionPrompt.value.trim();
  const options = [
    form.optionA.value.trim(),
    form.optionB.value.trim(),
    form.optionC.value.trim(),
    form.optionD.value.trim()
  ];
  const correctAnswerIndex = Number(form.correctAnswer.value);

  if (!prompt || options.some((option) => !option)) {
    showToast("Completez la question et toutes les options");
    return;
  }

  draftQuestions.push({ prompt, options, correctAnswerIndex });

  form.questionPrompt.value = "";
  form.optionA.value = "";
  form.optionB.value = "";
  form.optionC.value = "";
  form.optionD.value = "";
  form.correctAnswer.value = "0";

  renderDraftQuestions();
  showToast("Question ajoutee au brouillon");
}

function onSaveQuiz() {
  const form = dom.quizForm;
  const moduleId = form.moduleId.value;
  const sousAcquisId = form.sousAcquisId.value;
  const quizType = form.quizType.value;
  const quizTitle = form.quizTitle.value.trim();

  if (!moduleId || !sousAcquisId || !quizType || !quizTitle || !draftQuestions.length) {
    showToast("Selectionnez module, sous-acquis, type et ajoutez au moins une question");
    return;
  }

  let sousAcquis = findSousAcquis(moduleId, sousAcquisId);
  if (!sousAcquis) {
    let module = findModule(moduleId);
    if (!module) {
      const moduleNameFromFile = curriculumNames.modulesById[moduleId] || `Module ${moduleId}`;
      module = {
        id: moduleId,
        name: moduleNameFromFile,
        acquis: []
      };
      state.modules.push(module);
    }

    const acquis = getOrCreateDefaultAcquis(module);
    const sousAcquisName = curriculumNames.subAcquisById[sousAcquisId] || sousAcquisId;

    sousAcquis = {
      id: sousAcquisId,
      name: sousAcquisName,
      lessonsCount: 0,
      quizzes: []
    };

    acquis.sousAcquis.push(sousAcquis);
  }

  if (!Array.isArray(sousAcquis.quizzes)) {
    sousAcquis.quizzes = [];
  }

  sousAcquis.quizzes.push({
    id: uniqueId("quiz"),
    type: quizType,
    title: quizTitle,
    questions: draftQuestions.map((question) => ({ ...question }))
  });

  draftQuestions = [];
  form.quizTitle.value = "";
  renderDraftQuestions();
  saveState();
  refreshAll();
  showToast("Quiz enregistre");
}

async function onAddTeacher(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const teacherName = form.teacherFullName.value.trim();
  const teacherEmail = form.teacherEmail.value.trim().toLowerCase();
  const teacherPhone = form.teacherPhone.value.trim();
  const teacherPassword = form.teacherPassword.value;
  const isEditMode = Boolean(teacherEditState.teacherId);

  if (!teacherName || !teacherEmail || !teacherPhone || (!isEditMode && !teacherPassword)) return;

  if (teacherPassword && teacherPassword.length < 6) {
    showToast("Le mot de passe doit contenir au moins 6 caractères");
    return;
  }

  const emailExists = state.teachers.some(
    (teacher) =>
      String(teacher.email || "").toLowerCase() === teacherEmail &&
      String(teacher.id || "") !== teacherEditState.teacherId
  );
  const phoneExists = state.teachers.some(
    (teacher) =>
      String(teacher.phone || "").trim() === teacherPhone &&
      String(teacher.id || "") !== teacherEditState.teacherId
  );

  if (emailExists || phoneExists) {
    showToast("Cet enseignant existe déjà (email ou téléphone)");
    return;
  }

  let savedViaApi = false;
  let updatedTeacherFromApi = null;

  try {
    const response = await fetch(
      isEditMode
        ? `/api/backoffice/teachers/${encodeURIComponent(teacherEditState.teacherId)}`
        : "/api/backoffice/teachers",
      {
      method: isEditMode ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: teacherName,
        email: teacherEmail,
        phone: teacherPhone,
        password: teacherPassword
      })
    }
    );

    if (!response.ok) {
      const apiMessage = await parseApiError(response, "Impossible d'ajouter l'enseignant");
      if (response.status === 404 && /route not found/i.test(apiMessage) && isEditMode) {
        savedViaApi = false;
      } else {
        showToast(apiMessage);
        return;
      }
    } else {
      savedViaApi = true;
      const payload = await response.json();
      if (payload?.teacher) {
        updatedTeacherFromApi = payload.teacher;
      }
    }
  } catch (_error) {
    if (!isEditMode) {
      showToast("Connexion serveur indisponible");
      return;
    }
    savedViaApi = false;
  }

  if (updatedTeacherFromApi) {
    if (isEditMode) {
      state.teachers = state.teachers.map((teacher) =>
        teacher.id === updatedTeacherFromApi.id ? updatedTeacherFromApi : teacher
      );
      state.classes = state.classes.map((room) =>
        room.teacherId === updatedTeacherFromApi.id ? { ...room, teacherName: updatedTeacherFromApi.name } : room
      );
    } else {
      state.teachers.push(updatedTeacherFromApi);
    }
  } else if (isEditMode) {
    state.teachers = state.teachers.map((teacher) =>
      teacher.id === teacherEditState.teacherId
        ? {
            ...teacher,
            name: teacherName,
            email: teacherEmail,
            phone: teacherPhone
          }
        : teacher
    );
    state.classes = state.classes.map((room) =>
      room.teacherId === teacherEditState.teacherId ? { ...room, teacherName: teacherName } : room
    );
  }

  resetTeacherFormMode();
  saveState();
  refreshAll();
  if (isEditMode && !savedViaApi) {
    showToast("Enseignant modifie localement (backend a redemarrer)");
  } else {
    showToast(isEditMode ? "Enseignant modifie" : "Enseignant ajoute");
  }
}

async function onAddClass(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const className = form.className.value.trim();
  const teacherId = form.teacherId.value;

  if (!className || !teacherId) return;

  const teacher = state.teachers.find((item) => item.id === teacherId);
  if (!teacher) {
    showToast("Selection d'enseignant invalide");
    return;
  }

  try {
    const response = await fetch("/api/backoffice/classes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: className, teacherId: teacher.id })
    });

    if (!response.ok) {
      showToast(await parseApiError(response, "Impossible d'ajouter la classe"));
      return;
    }

    const payload = await response.json();
    if (payload?.classRoom) {
      state.classes.push(payload.classRoom);
    }
  } catch (_error) {
    showToast("Connexion serveur indisponible");
    return;
  }

  form.reset();
  saveState();
  refreshAll();
  showToast("Classe creee");
}

async function onAddStudent(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fullName = form.studentName.value.trim();
  const email = form.studentEmail.value.trim().toLowerCase();
  const identifier = form.studentIdentifier.value.trim();
  const password = form.studentPassword.value;
  const classId = form.classId.value;
  const isEditMode = Boolean(studentEditState.studentId);

  if (!fullName || !email || !identifier || (!isEditMode && !password) || !classId) return;

  if (password && password.length < 6) {
    showToast("Le mot de passe doit contenir au moins 6 caractères");
    return;
  }

  const duplicateStudent = state.students.some(
    (student) =>
      (String(student.identifier || "").toLowerCase() === identifier.toLowerCase() ||
        String(student.email || "").toLowerCase() === email) &&
      String(student.id || "") !== studentEditState.studentId
  );

  if (duplicateStudent) {
    showToast("Cet identifiant ou email étudiant existe déjà");
    return;
  }

  try {
    const response = await fetch(
      isEditMode
        ? `/api/backoffice/students/${encodeURIComponent(studentEditState.studentId)}`
        : "/api/backoffice/students",
      {
      method: isEditMode ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, email, identifier, password, classId })
    }
    );

    if (!response.ok) {
      showToast(await parseApiError(response, "Impossible d'ajouter l'étudiant"));
      return;
    }

    const payload = await response.json();
    if (payload?.student) {
      if (isEditMode) {
        state.students = state.students.map((student) =>
          student.id === payload.student.id ? payload.student : student
        );
      } else {
        state.students.push(payload.student);
      }
    }
  } catch (_error) {
    showToast("Connexion serveur indisponible");
    return;
  }

  closeStudentModal();
  saveState();
  refreshAll();
  showToast(isEditMode ? "Étudiant modifié" : "Étudiant ajouté");
}

async function onImportStudents(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const classId = form.classId.value;
  const file = dom.importStudentsFile.files && dom.importStudentsFile.files[0];

  if (!classId || !file) {
    showToast("Selectionnez une classe et un fichier JSON");
    return;
  }

  try {
    const fileContent = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Impossible de lire le fichier"));
      reader.readAsText(file);
    });

    const students = JSON.parse(fileContent);
    if (!Array.isArray(students)) {
      showToast("Le fichier JSON doit contenir un tableau d'étudiants");
      return;
    }

    let successCount = 0;
    let failCount = 0;

    for (const student of students) {
      const fullName = String(student?.fullName || "").trim();
      const email = String(student?.email || "").trim().toLowerCase();
      const identifier = String(student?.identifier || "").trim();
      const password = String(student?.password || "");

      if (!fullName || !email || !identifier || !password) {
        failCount++;
        continue;
      }

      try {
        const response = await fetch("/api/backoffice/students", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fullName, email, identifier, password, classId })
        });

        if (response.ok) {
          const payload = await response.json();
          if (payload?.student) {
            state.students.push(payload.student);
            successCount++;
          }
        } else {
          failCount++;
        }
      } catch (_error) {
        failCount++;
      }
    }

    form.reset();
    closeStudentModal();
    saveState();
    refreshAll();
    showToast(`Import: ${successCount} ajoutes${failCount > 0 ? `, ${failCount} en erreur` : ""}`);
  } catch (error) {
    console.error("JSON parse error:", error);
    showToast("Fichier JSON invalide ou erreur de lecture");
  }
}

async function onApplyAccess(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const classId = form.classId.value;
  const moduleId = form.moduleId.value;
  const accessRule = form.accessRule.value;

  if (!classId || !moduleId || !accessRule) return;

  const classRoom = state.classes.find((room) => room.id === classId);
  if (!classRoom) {
    showToast("Selection de classe invalide");
    return;
  }

  if (!classRoom.accessByModule) {
    classRoom.accessByModule = {};
  }

  try {
    const response = await fetch(`/api/backoffice/classes/${encodeURIComponent(classId)}/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moduleId, accessRule })
    });

    if (!response.ok) {
      showToast(await parseApiError(response, "Impossible de mettre à jour l'accès"));
      return;
    }

    const payload = await response.json();
    if (payload?.classRoom) {
      const index = state.classes.findIndex((room) => room.id === classId);
      if (index >= 0) {
        state.classes[index] = payload.classRoom;
      }
    } else {
      classRoom.accessByModule[moduleId] = accessRule;
    }
  } catch (_error) {
    showToast("Connexion serveur indisponible");
    return;
  }

  saveState();
  refreshAll();
  showToast("Règle d'accès mise à jour");
}

async function onGenerateSchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const startDate = form.startDate?.value;

  if (!startDate) {
    showToast("Date de démarrage requise");
    return;
  }

  try {
    const response = await fetch("/api/backoffice/classes/schedule-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ startDate })
    });

    if (!response.ok) {
      showToast(await parseApiError(response, "Impossible de générer le calendrier"));
      return;
    }

    const payload = await response.json();
    if (Array.isArray(payload?.classes)) {
      state.classes = payload.classes;
    }

    saveState();
    refreshAll();
    const generatedCount = Number(payload?.generatedCount || 0);
    const classCount = Number(payload?.updatedClassCount || 0);
    showToast(`Calendrier global généré (${generatedCount} sous-acquis x ${classCount} classes)`);
  } catch (_error) {
    showToast("Connexion serveur indisponible");
  }
}

function onRenameAcquis() {
  const module = findModule(dom.manageModuleSelect.value);
  const acquisId = dom.manageAcquisSelect.value;
  const newName = String(dom.manageAcquisName?.value || "").trim();

  if (!module || !acquisId || !newName) {
    showToast("Selectionnez un module/acquis et saisissez un nom");
    return;
  }

  const acquis = Array.isArray(module.acquis)
    ? module.acquis.find((entry) => entry.id === acquisId)
    : null;
  if (!acquis) {
    showToast("Acquis introuvable");
    return;
  }

  const duplicate = module.acquis.some(
    (entry) => entry.id !== acquisId && String(entry.name || "").toLowerCase() === newName.toLowerCase()
  );

  if (duplicate) {
    showToast("Un acquis avec ce nom existe déjà");
    return;
  }

  acquis.name = newName;
  saveState();
  refreshAll();
  showToast("Acquis modifie");
}

function onDeleteAcquis() {
  const module = findModule(dom.manageModuleSelect.value);
  const acquisId = dom.manageAcquisSelect.value;

  if (!module || !acquisId) {
    showToast("Sélectionnez un acquis à supprimer");
    return;
  }

  const target = module.acquis.find((entry) => entry.id === acquisId);
  if (!target) {
    showToast("Acquis introuvable");
    return;
  }

  if (!window.confirm(`Supprimer l'acquis \"${target.name}\" et tout son contenu ?`)) {
    return;
  }

  module.acquis = module.acquis.filter((entry) => entry.id !== acquisId);
  saveState();
  refreshAll();
  showToast("Acquis supprimé");
}

function onRenameSousAcquis() {
  const module = findModule(dom.manageModuleSelect.value);
  const acquis = Array.isArray(module?.acquis)
    ? module.acquis.find((entry) => entry.id === dom.manageAcquisSelect.value)
    : null;
  const sousAcquisId = dom.manageSousAcquisSelect.value;
  const newName = String(dom.manageSousAcquisName?.value || "").trim();

  if (!module || !acquis || !sousAcquisId || !newName) {
    showToast("Selectionnez un sous-acquis et saisissez un nom");
    return;
  }

  const sousAcquis = Array.isArray(acquis.sousAcquis)
    ? acquis.sousAcquis.find((entry) => entry.id === sousAcquisId)
    : null;
  if (!sousAcquis) {
    showToast("Sous-acquis introuvable");
    return;
  }

  const duplicate = acquis.sousAcquis.some(
    (entry) => entry.id !== sousAcquisId && String(entry.name || "").toLowerCase() === newName.toLowerCase()
  );

  if (duplicate) {
    showToast("Un sous-acquis avec ce nom existe déjà");
    return;
  }

  sousAcquis.name = newName;
  saveState();
  refreshAll();
  showToast("Sous-acquis modifie");
}

function onDeleteSousAcquis() {
  const module = findModule(dom.manageModuleSelect.value);
  const acquis = Array.isArray(module?.acquis)
    ? module.acquis.find((entry) => entry.id === dom.manageAcquisSelect.value)
    : null;
  const sousAcquisId = dom.manageSousAcquisSelect.value;

  if (!module || !acquis || !sousAcquisId) {
    showToast("Sélectionnez un sous-acquis à supprimer");
    return;
  }

  const target = acquis.sousAcquis.find((entry) => entry.id === sousAcquisId);
  if (!target) {
    showToast("Sous-acquis introuvable");
    return;
  }

  if (!window.confirm(`Supprimer le sous-acquis \"${target.name}\" et ses quiz ?`)) {
    return;
  }

  acquis.sousAcquis = acquis.sousAcquis.filter((entry) => entry.id !== sousAcquisId);
  saveState();
  refreshAll();
  showToast("Sous-acquis supprimé");
}

function onRenameQuiz() {
  const module = findModule(dom.manageModuleSelect.value);
  const acquis = Array.isArray(module?.acquis)
    ? module.acquis.find((entry) => entry.id === dom.manageAcquisSelect.value)
    : null;
  const sousAcquis = Array.isArray(acquis?.sousAcquis)
    ? acquis.sousAcquis.find((entry) => entry.id === dom.manageSousAcquisSelect.value)
    : null;
  const quizId = dom.manageQuizSelect.value;
  const newTitle = String(dom.manageQuizTitle?.value || "").trim();

  if (!module || !acquis || !sousAcquis || !quizId || !newTitle) {
    showToast("Selectionnez un quiz et saisissez un titre");
    return;
  }

  const quiz = Array.isArray(sousAcquis.quizzes)
    ? sousAcquis.quizzes.find((entry) => entry.id === quizId)
    : null;
  if (!quiz) {
    showToast("Quiz introuvable");
    return;
  }

  const duplicate = sousAcquis.quizzes.some(
    (entry) => entry.id !== quizId && String(entry.title || "").toLowerCase() === newTitle.toLowerCase()
  );

  if (duplicate) {
    showToast("Un quiz avec ce titre existe déjà");
    return;
  }

  quiz.title = newTitle;
  saveState();
  refreshAll();
  showToast("Quiz modifie");
}

function onDeleteQuiz() {
  const module = findModule(dom.manageModuleSelect.value);
  const acquis = Array.isArray(module?.acquis)
    ? module.acquis.find((entry) => entry.id === dom.manageAcquisSelect.value)
    : null;
  const sousAcquis = Array.isArray(acquis?.sousAcquis)
    ? acquis.sousAcquis.find((entry) => entry.id === dom.manageSousAcquisSelect.value)
    : null;
  const quizId = dom.manageQuizSelect.value;

  if (!module || !acquis || !sousAcquis || !quizId) {
    showToast("Sélectionnez un quiz à supprimer");
    return;
  }

  const target = sousAcquis.quizzes.find((entry) => entry.id === quizId);
  if (!target) {
    showToast("Quiz introuvable");
    return;
  }

  if (!window.confirm(`Supprimer le quiz \"${target.title || "Sans titre"}\" ?`)) {
    return;
  }

  sousAcquis.quizzes = sousAcquis.quizzes.filter((entry) => entry.id !== quizId);
  saveState();
  refreshAll();
  showToast("Quiz supprimé");
}

function showToast(message) {
  dom.toast.textContent = message;
  dom.toast.classList.add("visible");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => {
    dom.toast.classList.remove("visible");
  }, 1800);
}

// ========== INLINE AI QUIZ PANEL ==========

function setupAiQuizPanel({ prefix, getContext, onValidate }) {
  const toggleBtn = document.getElementById(`${prefix}-toggle`);
  const body = document.getElementById(`${prefix}-body`);
  const difficultyEl = document.getElementById(`${prefix}-difficulty`);
  const countEl = document.getElementById(`${prefix}-count`);
  const generateBtn = document.getElementById(`${prefix}-generate-btn`);
  const resultsEl = document.getElementById(`${prefix}-results`);
  const footer = document.getElementById(`${prefix}-footer`);
  const titleInput = document.getElementById(`${prefix}-title`);
  const validateBtn = document.getElementById(`${prefix}-validate-btn`);

  if (!toggleBtn || !body) return;

  const OPT_LABELS = ["A", "B", "C", "D", "E"];
  let panelQuestions = [];
  let panelSelected = new Set();
  let editingIndex = null;

  toggleBtn.addEventListener("click", () => {
    const next = body.hidden;
    body.hidden = !next;
    toggleBtn.classList.toggle("ai-quiz-toggle--active", next);
  });

  generateBtn?.addEventListener("click", async () => {
    const ctx = getContext();
    if (!ctx.moduleId) { showToast("Ouvrez d'abord un module"); return; }
    if (!ctx.subAcquisName) { showToast("Remplissez d'abord le nom du sous-acquis"); return; }

    generateBtn.disabled = true;
    generateBtn.textContent = "Génération…";
    if (resultsEl) resultsEl.innerHTML = '<p class="ai-loading">Génération en cours…</p>';
    if (footer) footer.hidden = true;

    try {
      const resp = await fetch("/api/teacher/quizzes/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          moduleId: ctx.moduleId,
          subAcquisId: ctx.subAcquisId || "",
          subAcquisName: ctx.subAcquisName,
          acquisName: ctx.acquisName || "",
          difficulty: difficultyEl?.value || "intermediate",
          count: Number(countEl?.value || 5)
        })
      });
      if (!resp.ok) throw new Error("Échec génération");
      const data = await resp.json();
      panelQuestions = Array.isArray(data.questions) ? data.questions : [];
      panelSelected = new Set(panelQuestions.map((_, i) => i));
      editingIndex = null;
      renderPanelQuestions();
      if (footer) footer.hidden = !panelQuestions.length;
    } catch (_err) {
      if (resultsEl) resultsEl.innerHTML = '<p class="ai-error">Erreur lors de la génération. Réessayez.</p>';
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = "Générer";
    }
  });

  resultsEl?.addEventListener("click", (event) => {
    const editBtn = event.target.closest("[data-edit-qi]");
    if (editBtn) {
      const i = Number(editBtn.dataset.editQi);
      editingIndex = editingIndex === i ? null : i;
      renderPanelQuestions();
      return;
    }

    const cancelBtn = event.target.closest("[data-cancel-edit]");
    if (cancelBtn) {
      editingIndex = null;
      renderPanelQuestions();
      return;
    }

    const saveBtn = event.target.closest("[data-save-edit]");
    if (saveBtn) {
      const i = Number(saveBtn.dataset.saveEdit);
      const promptTA = resultsEl.querySelector(".ai-edit-prompt");
      const optInputs = Array.from(resultsEl.querySelectorAll(".ai-edit-opt-input"));
      const correctRadio = resultsEl.querySelector(".ai-edit-correct-radio:checked");
      const newPrompt = promptTA ? promptTA.value.trim() : panelQuestions[i].prompt;
      const newOptions = optInputs.map((el) => el.value.trim()).filter(Boolean);
      const newCorrect = correctRadio ? Number(correctRadio.value) : 0;
      panelQuestions[i] = { ...panelQuestions[i], prompt: newPrompt, options: newOptions, correctOptionIndex: newCorrect, correctAnswerIndex: newCorrect };
      editingIndex = null;
      renderPanelQuestions();
      return;
    }
  });

  resultsEl?.addEventListener("change", (event) => {
    const cb = event.target.closest("input[type='checkbox'][data-qi]");
    if (!cb) return;
    const i = Number(cb.dataset.qi);
    if (cb.checked) panelSelected.add(i); else panelSelected.delete(i);
  });

  validateBtn?.addEventListener("click", () => {
    if (!panelSelected.size) { showToast("Sélectionnez au moins une question"); return; }
    const questions = Array.from(panelSelected).sort((a, b) => a - b)
      .map((i) => panelQuestions[i]).filter(Boolean)
      .map((q) => ({
        prompt: String(q.prompt || "").trim(),
        options: Array.isArray(q.options) ? q.options.map((o) => String(o || "").trim()) : [],
        correctAnswerIndex: typeof q.correctOptionIndex === "number" ? q.correctOptionIndex : typeof q.correctAnswerIndex === "number" ? q.correctAnswerIndex : 0
      }));
    const title = String(titleInput?.value || "").trim() || "Quiz généré";
    onValidate(title, questions);
    panelQuestions = []; panelSelected = new Set(); editingIndex = null;
    if (resultsEl) resultsEl.innerHTML = "";
    if (footer) footer.hidden = true;
    if (titleInput) titleInput.value = "";
    body.hidden = true;
    toggleBtn.classList.remove("ai-quiz-toggle--active");
  });

  function getCorrectIndex(q) {
    return typeof q.correctOptionIndex === "number" ? q.correctOptionIndex
      : typeof q.correctAnswerIndex === "number" ? q.correctAnswerIndex : -1;
  }

  function renderPanelQuestions() {
    if (!resultsEl) return;
    if (!panelQuestions.length) {
      resultsEl.innerHTML = '<p class="ai-empty">Aucune question générée.</p>';
      return;
    }
    resultsEl.innerHTML = panelQuestions.map((q, i) => {
      const opts = Array.isArray(q.options) ? q.options : [];
      const ci = getCorrectIndex(q);
      const isEditing = editingIndex === i;

      const questionView = isEditing
        ? `<div class="ai-edit-form">
            <label class="ai-edit-label">Question
              <textarea class="ai-edit-prompt" rows="3">${htmlEscape(q.prompt || "")}</textarea>
            </label>
            <div class="ai-edit-opts">
              ${opts.map((o, oi) => `
                <div class="ai-edit-opt-row">
                  <input type="radio" name="ai-correct-${prefix}-${i}" class="ai-edit-correct-radio" value="${oi}" ${oi === ci || (ci < 0 && oi === 0) ? "checked" : ""} />
                  <span class="ai-edit-opt-label">${OPT_LABELS[oi] || oi + 1}</span>
                  <input type="text" class="ai-edit-opt-input" value="${escapeAttr(o)}" />
                </div>`).join("")}
            </div>
            <div class="ai-edit-actions">
              <button type="button" class="secondary-btn" data-save-edit="${i}">Enregistrer</button>
              <button type="button" class="ai-cancel-link" data-cancel-edit>Annuler</button>
            </div>
          </div>`
        : `<p class="ai-qcard-prompt-text">${htmlEscape(q.prompt || "")}</p>
           <ul class="ai-qcard-opts">
             ${opts.map((o, oi) => `
               <li class="ai-qcard-opt${oi === ci ? " ai-opt-correct" : ""}">
                 <span class="ai-opt-label">${OPT_LABELS[oi] || oi + 1}</span>${htmlEscape(o)}
               </li>`).join("")}
           </ul>`;

      return `<div class="ai-qcard${isEditing ? " ai-qcard--editing" : ""}">
        <div class="ai-qcard-head">
          <label class="ai-qcard-check">
            <input type="checkbox" data-qi="${i}" ${panelSelected.has(i) ? "checked" : ""} />
          </label>
          <span class="ai-qcard-num">Q${i + 1}</span>
          <div class="ai-qcard-body">${questionView}</div>
          <button type="button" class="ai-edit-btn${isEditing ? " ai-edit-btn--active" : ""}" data-edit-qi="${i}">${isEditing ? "✕" : "Éditer"}</button>
        </div>
      </div>`;
    }).join("");
  }
}
