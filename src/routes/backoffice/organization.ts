/**
 * Back-office organization management: teachers, classes, students,
 * module access rules and unlock schedules.
 */
import { Router } from "express";
import mongoose from "mongoose";
import { requireRole } from "../../middleware/auth";
import { User } from "../../models/User";
import { Teacher } from "../../models/Teacher";
import { ClassRoom } from "../../models/ClassRoom";
import { StudentProfile } from "../../models/StudentProfile";
import { hashPassword } from "../../utils/password";
import { MLPredictorService } from "../../services/MLPredictorService";
import { resolveRiskExplanation, type RiskExplanation } from "../../services/prediction/explain";
import { extractMLFeatures } from "../../services/prediction/features";
import { computeModuleQuizScores, computeStudentProgress } from "../../services/studentProgress";
import { computeStudentMasterySummary } from "../../services/mastery/masterySummary";
import { computeAttentionAnalytics } from "../../services/attention/attentionClient";
import { Meeting } from "../../models/Meeting";
import {
  buildScheduleBySubAcquis,
  encodeScheduleStorageKey,
  isOwnedByCaller,
  parseStartDateInput,
  readCalendarWeekMapFromFile,
  toAccessRecord,
  toIsoDateOrNull,
  toScheduleIsoRecord
} from "../../services/classAccess";
// Transitional: curriculum reads still live in web.ts until that domain is extracted.
import { readPersistedProgramCOverview, resolveTotalSubAcquisCount } from "../web";

export const organizationRouter = Router();

organizationRouter.get("/api/backoffice/organization", async (req, res) => {
  try {
    // Identity comes from the verified session (JWT), never a client header.
    // The /api/backoffice guard guarantees req.auth is a teacher or admin.
    const callerIsAdmin = req.auth?.role === "admin";
    const callerTeacherId = req.auth?.id ?? "";

    const [teachers, allClasses, allStudents] = await Promise.all([
      Teacher.find().sort({ name: 1 }).lean(),
      ClassRoom.find().sort({ name: 1 }).lean(),
      StudentProfile.find().sort({ fullName: 1 }).lean()
    ]);

    // Filter classes and students for non-admin callers
    const classes = callerIsAdmin
      ? allClasses
      : allClasses.filter((room) => {
          const roomTeacherId = room.teacherId ? String(room.teacherId) : "";
          return roomTeacherId === callerTeacherId;
        });

    const allowedClassIds = new Set(classes.map((room) => String(room._id)));
    const students = callerIsAdmin
      ? allStudents
      : allStudents.filter((student) => allowedClassIds.has(String(student.classId || "")));

    const identifiers = students
      .map((student) => String(student.identifier || "").trim())
      .filter(Boolean);

    const users = identifiers.length
      ? await User.find({ identifier: { $in: identifiers } })
          .select({ identifier: 1, progress: 1 })
          .lean()
      : [];

    const profiles = identifiers.length
      ? await StudentProfile.find({ identifier: { $in: identifiers } })
          .select({ identifier: 1, loginCount: 1, lastLoginDate: 1, createdAt: 1 })
          .lean()
      : [];

    const userByIdentifier = new Map(
      users.map((user) => [String((user as any).identifier || "").trim(), user])
    );

    const profileByIdentifier = new Map(
      profiles.map((p) => [String((p as any).identifier || "").trim(), p])
    );

    // Resolve prediction inputs once for the whole roster.
    const orgTotalSubAcquis = await resolveTotalSubAcquisCount();
    const scheduleByClassId = new Map(
      allClasses.map((room) => [String(room._id), (room as any).scheduleStartDate || null])
    );

    // Gather every student's features once, then predict the whole class in a
    // single call to the Python ML service (one HTTP round trip, not one/student).
    const studentRows = students.map((student) => {
      const identifier = String(student.identifier || "").trim();
      const user = identifier ? userByIdentifier.get(identifier) : null;
      const prof = identifier ? profileByIdentifier.get(identifier) : null;
      const stats = user ? computeStudentProgress((user as any).progress) : null;
      const features = extractMLFeatures({
        progress: (user as any)?.progress,
        profile: prof as any,
        totalSubAcquis: orgTotalSubAcquis,
        scheduleStartDate: scheduleByClassId.get(String(student.classId || "")) || null
      });
      return { student, identifier, user, prof, stats, features };
    });
    const predictions = await MLPredictorService.predictBatch(studentRows.map((r) => r.features));
    const studentsPayload = studentRows.map((r, i) => ({
      id: String(r.student._id),
      fullName: r.student.fullName,
      identifier: r.identifier,
      email: r.student.email || "",
      classId: r.student.classId ? String(r.student.classId) : "",
      lessonsCompleted: r.stats?.lessonsCompleted ?? Number(r.student.lessonsCompleted || 0),
      quizzesTaken: r.stats?.quizzesPassed ?? Number(r.student.quizzesTaken || 0),
      averageQuizGrade: r.stats?.averageQuizScoreOn20 ?? Number(r.student.averageQuizGrade || 0),
      catchupProbability: predictions[i].catchupProbability,
      predictedGrade: predictions[i].predictedGrade,
      lastLoginDate: (r.prof as any)?.lastLoginDate ? new Date((r.prof as any).lastLoginDate).toISOString() : null,
      quizScoresByModule: computeModuleQuizScores((r.user as any)?.progress?.quizResults)
    }));

    res.status(200).json({
      // Full roster (with contact info) is admin-only — the teacher-management
      // UI is already admin-gated on the frontend; a regular teacher doesn't
      // need colleagues' emails/phones (per-class teacherName is included below).
      teachers: callerIsAdmin
        ? teachers.map((teacher) => ({
            id: String(teacher._id),
            role: teacher.role || "enseignant",
            name: teacher.name,
            email: teacher.email || "",
            phone: teacher.phone || ""
          }))
        : [],
      classes: classes.map((room) => ({
        id: String(room._id),
        name: room.name,
        teacherId: room.teacherId ? String(room.teacherId) : "",
        teacherName: room.teacherName || "Enseignant non assigne",
        accessByModule: toAccessRecord((room as any).accessByModule),
        scheduleStartDate: toIsoDateOrNull(room.scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord((room as any).accessScheduleBySubAcquis)
      })),
      students: studentsPayload
    });
  } catch (error) {
    console.error("Failed to load backoffice organization:", error);
    res.status(500).json({ message: "Impossible de charger l'organisation" });
  }
});

// Teacher accounts are admin-only to manage: the router-level guard only proves
// SOME teacher/admin is logged in, and without this, any "enseignant" could
// create/edit/delete (including password-reset) any other teacher OR admin.
organizationRouter.post("/api/backoffice/teachers", requireRole("admin"), async (req, res) => {
  try {
    const name = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ message: "Nom complet, email, telephone et mot de passe sont requis" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Le mot de passe doit contenir au moins 6 caracteres" });
    }

    const existing = await Teacher.findOne({
      $or: [{ email }, { phone }]
    })
      .select({ _id: 1 })
      .lean();

    if (existing) {
      return res.status(409).json({ message: "Cet enseignant existe deja (email ou telephone)" });
    }

    const teacher = await Teacher.create({ name, email, phone, password });
    res.status(201).json({
      teacher: {
        id: String(teacher._id),
        role: teacher.role || "enseignant",
        name: teacher.name,
        email: teacher.email,
        phone: teacher.phone
      }
    });
  } catch (error) {
    console.error("Failed to create teacher:", error);
    res.status(500).json({ message: "Impossible d'ajouter l'enseignant" });
  }
});

organizationRouter.put("/api/backoffice/teachers/:teacherId", requireRole("admin"), async (req, res) => {
  try {
    const teacherId = typeof req.params?.teacherId === "string" ? req.params.teacherId.trim() : "";
    const name = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!mongoose.isValidObjectId(teacherId)) {
      return res.status(400).json({ message: "Identifiant enseignant invalide" });
    }

    if (!name || !email || !phone) {
      return res.status(400).json({ message: "Nom complet, email et telephone sont requis" });
    }

    if (password && password.length < 6) {
      return res.status(400).json({ message: "Le mot de passe doit contenir au moins 6 caracteres" });
    }

    const teacher = await Teacher.findById(teacherId);
    if (!teacher) {
      return res.status(404).json({ message: "Enseignant introuvable" });
    }

    const duplicate = await Teacher.findOne({
      _id: { $ne: teacher._id },
      $or: [{ email }, { phone }]
    })
      .select({ _id: 1 })
      .lean();

    if (duplicate) {
      return res.status(409).json({ message: "Cet enseignant existe deja (email ou telephone)" });
    }

    teacher.name = name;
    teacher.email = email;
    teacher.phone = phone;
    if (password) {
      teacher.password = await hashPassword(password);
    }

    await teacher.save();

    await ClassRoom.updateMany(
      { teacherId: teacher._id },
      { $set: { teacherName: teacher.name } }
    );

    res.status(200).json({
      teacher: {
        id: String(teacher._id),
        role: teacher.role || "enseignant",
        name: teacher.name,
        email: teacher.email,
        phone: teacher.phone
      }
    });
  } catch (error) {
    console.error("Failed to update teacher:", error);
    res.status(500).json({ message: "Impossible de modifier l'enseignant" });
  }
});

organizationRouter.delete("/api/backoffice/teachers/:teacherId", requireRole("admin"), async (req, res) => {
  try {
    const teacherId = typeof req.params?.teacherId === "string" ? req.params.teacherId.trim() : "";

    if (!mongoose.isValidObjectId(teacherId)) {
      return res.status(400).json({ message: "Identifiant enseignant invalide" });
    }

    const teacher = await Teacher.findById(teacherId).select({ _id: 1 }).lean();
    if (!teacher) {
      return res.status(404).json({ message: "Enseignant introuvable" });
    }

    const assignedClass = await ClassRoom.findOne({ teacherId: teacher._id })
      .select({ _id: 1 })
      .lean();

    if (assignedClass) {
      return res.status(409).json({
        message: "Impossible de supprimer cet enseignant: il est encore assigne a une classe"
      });
    }

    await Teacher.deleteOne({ _id: teacher._id });
    res.status(200).json({ message: "Enseignant supprime" });
  } catch (error) {
    console.error("Failed to delete teacher:", error);
    res.status(500).json({ message: "Impossible de supprimer l'enseignant" });
  }
});

// Returns the classes visible to the caller (resolved from the verified session),
// each annotated with its live student count. Used by the clustering dashboard's
// class selector.
organizationRouter.get("/api/backoffice/classes", async (req, res) => {
  try {
    // Identity comes from the verified session (JWT), never a client header.
    const callerIsAdmin = req.auth?.role === "admin";
    const callerTeacherId = req.auth?.id ?? "";

    const allClasses = await ClassRoom.find().sort({ name: 1 }).lean();
    const classes = callerIsAdmin
      ? allClasses
      : allClasses.filter((room) => String(room.teacherId || "") === callerTeacherId);

    const classIds = classes.map((room) => room._id);
    const students = classIds.length
      ? await StudentProfile.find({ classId: { $in: classIds } }).select({ classId: 1 }).lean()
      : [];

    const countByClassId = new Map<string, number>();
    for (const student of students as any[]) {
      const key = String(student.classId || "");
      countByClassId.set(key, (countByClassId.get(key) || 0) + 1);
    }

    return res.status(200).json({
      classes: classes.map((room) => ({
        id: String(room._id),
        name: room.name,
        teacherId: room.teacherId ? String(room.teacherId) : "",
        studentCount: countByClassId.get(String(room._id)) || 0
      }))
    });
  } catch (error) {
    console.error("Failed to load backoffice classes:", error);
    return res.status(500).json({ message: "Impossible de charger les classes" });
  }
});

organizationRouter.post("/api/backoffice/classes", async (req, res) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const teacherId = typeof req.body?.teacherId === "string" ? req.body.teacherId.trim() : "";

    if (!name || !teacherId) {
      return res.status(400).json({ message: "Nom de classe et enseignant sont requis" });
    }

    const teacher = await Teacher.findById(teacherId).lean();
    if (!teacher) {
      return res.status(404).json({ message: "Enseignant introuvable" });
    }

    const duplicate = await ClassRoom.findOne({ name: new RegExp(`^${name}$`, "i") })
      .select({ _id: 1 })
      .lean();
    if (duplicate) {
      return res.status(409).json({ message: "Cette classe existe deja" });
    }

    const classRoom = await ClassRoom.create({
      name,
      teacherId: teacher._id,
      teacherName: teacher.name,
      accessByModule: {},
      scheduleStartDate: null,
      accessScheduleBySubAcquis: {}
    });

    res.status(201).json({
      classRoom: {
        id: String(classRoom._id),
        name: classRoom.name,
        teacherId: String(classRoom.teacherId),
        teacherName: classRoom.teacherName,
        accessByModule: toAccessRecord(classRoom.accessByModule),
        scheduleStartDate: toIsoDateOrNull(classRoom.scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord(classRoom.accessScheduleBySubAcquis)
      }
    });
  } catch (error) {
    console.error("Failed to create class:", error);
    res.status(500).json({ message: "Impossible d'ajouter la classe" });
  }
});

organizationRouter.post("/api/backoffice/students", async (req, res) => {
  try {
    const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const classId = typeof req.body?.classId === "string" ? req.body.classId.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!fullName || !identifier || !password || !classId || !email) {
      return res.status(400).json({ message: "Nom, email, identifiant, mot de passe et classe sont requis" });
    }

    if (identifier.length < 3) {
      return res.status(400).json({ message: "L'identifiant doit contenir au moins 3 caracteres" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Le mot de passe doit contenir au moins 6 caracteres" });
    }

    const classRoom = await ClassRoom.findById(classId).lean();
    if (!classRoom) {
      return res.status(404).json({ message: "Classe introuvable" });
    }

    // The /api/backoffice guard only proves the caller is SOME teacher/admin —
    // without this, any teacher could add a student straight into another
    // teacher's class.
    if (!isOwnedByCaller((classRoom as any).teacherId, req.auth)) {
      return res.status(403).json({ message: "Accès non autorisé à cette classe" });
    }

    const [existingProfile, existingUser] = await Promise.all([
      StudentProfile.findOne({ $or: [{ identifier }, { email }] }).select({ _id: 1 }).lean(),
      User.findOne({ $or: [{ identifier }, { email }] }).select({ _id: 1 }).lean()
    ]);

    if (existingProfile || existingUser) {
      return res.status(409).json({ message: "Cet identifiant ou email etudiant existe deja" });
    }

    const user = await User.create({ fullName, identifier, email, password });

    let student;
    try {
      student = await StudentProfile.create({
        fullName,
        identifier,
        email,
        classId: classRoom._id,
        lessonsCompleted: 0,
        quizzesTaken: 0,
        averageQuizGrade: 0
      });
    } catch (profileError) {
      await User.deleteOne({ _id: user._id }).catch(() => undefined);
      throw profileError;
    }

    res.status(201).json({
      student: {
        id: String(student._id),
        fullName: student.fullName,
        identifier: student.identifier,
        email: student.email || "",
        classId: String(student.classId),
        lessonsCompleted: Number(student.lessonsCompleted || 0),
        quizzesTaken: Number(student.quizzesTaken || 0),
        averageQuizGrade: Number(student.averageQuizGrade || 0)
      }
    });
  } catch (error) {
    console.error("Failed to create student:", error);
    res.status(500).json({ message: "Impossible d'ajouter l'etudiant" });
  }
});

organizationRouter.put("/api/backoffice/students/:studentId", async (req, res) => {
  try {
    const studentId = String(req.params.studentId || "").trim();
    const fullName = typeof req.body?.fullName === "string" ? req.body.fullName.trim() : "";
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const classId = typeof req.body?.classId === "string" ? req.body.classId.trim() : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";

    if (!mongoose.isValidObjectId(studentId)) {
      return res.status(400).json({ message: "Identifiant etudiant invalide" });
    }

    if (!fullName || !identifier || !classId || !email) {
      return res.status(400).json({ message: "Nom, email, identifiant et classe sont requis" });
    }

    if (identifier.length < 3) {
      return res.status(400).json({ message: "L'identifiant doit contenir au moins 3 caracteres" });
    }

    if (password && password.length < 6) {
      return res.status(400).json({ message: "Le mot de passe doit contenir au moins 6 caracteres" });
    }

    const classRoom = await ClassRoom.findById(classId).lean();
    if (!classRoom) {
      return res.status(404).json({ message: "Classe introuvable" });
    }

    const student = await StudentProfile.findById(studentId);
    if (!student) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    // The /api/backoffice guard only proves the caller is SOME teacher/admin —
    // without this, any teacher could edit (including reset the password of)
    // another teacher's student, or move a student into a class that isn't
    // theirs either. Check both the student's CURRENT class and the target one.
    {
      // isOwnedByCaller already lets an admin through on both checks, so no
      // separate admin-bypass branch is needed here.
      const currentClassRoom = student.classId
        ? await ClassRoom.findById(student.classId).select({ teacherId: 1 }).lean()
        : null;
      const ownsCurrentClass = isOwnedByCaller(
        currentClassRoom ? (currentClassRoom as any).teacherId : undefined,
        req.auth
      );
      const ownsTargetClass = isOwnedByCaller((classRoom as any).teacherId, req.auth);
      if (!ownsCurrentClass || !ownsTargetClass) {
        return res.status(403).json({ message: "Accès non autorisé à cet étudiant" });
      }
    }

    const linkedUser = await User.findOne({
      $or: [{ identifier: student.identifier }, { email: student.email || "" }]
    });

    const [existingProfile, existingUser] = await Promise.all([
      StudentProfile.findOne({
        _id: { $ne: student._id },
        $or: [{ identifier }, { email }]
      })
        .select({ _id: 1 })
        .lean(),
      User.findOne({
        _id: linkedUser?._id ? { $ne: linkedUser._id } : { $exists: true },
        $or: [{ identifier }, { email }]
      })
        .select({ _id: 1 })
        .lean()
    ]);

    if (existingProfile || existingUser) {
      return res.status(409).json({ message: "Cet identifiant ou email etudiant existe deja" });
    }

    student.fullName = fullName;
    student.identifier = identifier;
    student.email = email;
    student.classId = classRoom._id;
    await student.save();

    if (linkedUser) {
      linkedUser.fullName = fullName;
      linkedUser.identifier = identifier;
      linkedUser.email = email;
      if (password) {
        linkedUser.password = password;
      }
      await linkedUser.save();
    }

    res.status(200).json({
      student: {
        id: String(student._id),
        fullName: student.fullName,
        identifier: student.identifier,
        email: student.email || "",
        classId: String(student.classId),
        lessonsCompleted: Number(student.lessonsCompleted || 0),
        quizzesTaken: Number(student.quizzesTaken || 0),
        averageQuizGrade: Number(student.averageQuizGrade || 0)
      }
    });
  } catch (error) {
    console.error("Failed to update student:", error);
    res.status(500).json({ message: "Impossible de modifier l'etudiant" });
  }
});

organizationRouter.delete("/api/backoffice/students/:studentId", async (req, res) => {
  try {
    const studentId = String(req.params.studentId || "").trim();

    if (!mongoose.isValidObjectId(studentId)) {
      return res.status(400).json({ message: "Identifiant etudiant invalide" });
    }

    const student = await StudentProfile.findById(studentId).lean();
    if (!student) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    // The /api/backoffice guard only proves the caller is SOME teacher/admin —
    // without this, any teacher could delete another teacher's student.
    if (req.auth?.role !== "admin") {
      const classRoom = (student as any).classId
        ? await ClassRoom.findById((student as any).classId).select({ teacherId: 1 }).lean()
        : null;
      if (!classRoom || !isOwnedByCaller((classRoom as any).teacherId, req.auth)) {
        return res.status(403).json({ message: "Accès non autorisé à cet étudiant" });
      }
    }

    await StudentProfile.deleteOne({ _id: student._id });
    await User.deleteOne({
      $or: [{ identifier: student.identifier }, { email: student.email || "" }]
    });

    res.status(200).json({ message: "Etudiant supprime" });
  } catch (error) {
    console.error("Failed to delete student:", error);
    res.status(500).json({ message: "Impossible de supprimer l'etudiant" });
  }
});

organizationRouter.post("/api/backoffice/classes/:classId/access", async (req, res) => {
  try {
    const classId = String(req.params.classId || "").trim();
    const moduleId = typeof req.body?.moduleId === "string" ? req.body.moduleId.trim() : "";
    const accessRule = typeof req.body?.accessRule === "string" ? req.body.accessRule.trim() : "";

    if (!classId || !moduleId || !accessRule) {
      return res.status(400).json({ message: "classId, moduleId et accessRule sont requis" });
    }

    const classRoom = await ClassRoom.findById(classId);
    if (!classRoom) {
      return res.status(404).json({ message: "Classe introuvable" });
    }

    // The /api/backoffice guard only proves the caller is SOME teacher/admin —
    // without this, any teacher could block/unblock modules in another
    // teacher's class.
    if (!isOwnedByCaller(classRoom.teacherId, req.auth)) {
      return res.status(403).json({ message: "Accès non autorisé à cette classe" });
    }

    const access = classRoom.accessByModule || new Map<string, string>();
    access.set(moduleId, accessRule);
    classRoom.accessByModule = access;
    await classRoom.save();

    res.status(200).json({
      classRoom: {
        id: String(classRoom._id),
        name: classRoom.name,
        teacherId: String(classRoom.teacherId),
        teacherName: classRoom.teacherName,
        accessByModule: toAccessRecord(classRoom.accessByModule),
        scheduleStartDate: toIsoDateOrNull(classRoom.scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord(classRoom.accessScheduleBySubAcquis)
      }
    });
  } catch (error) {
    console.error("Failed to update class access:", error);
    res.status(500).json({ message: "Impossible de mettre a jour l'acces de la classe" });
  }
});

organizationRouter.post("/api/backoffice/classes/:classId/schedule", async (req, res) => {
  try {
    const classId = String(req.params.classId || "").trim();
    const startDateInput = typeof req.body?.startDate === "string" ? req.body.startDate.trim() : "";

    if (!classId || !startDateInput) {
      return res.status(400).json({ message: "classId et startDate sont requis" });
    }

    const classRoom = await ClassRoom.findById(classId);
    if (!classRoom) {
      return res.status(404).json({ message: "Classe introuvable" });
    }

    // The /api/backoffice guard only proves the caller is SOME teacher/admin —
    // without this, any teacher could reschedule another teacher's class.
    if (!isOwnedByCaller(classRoom.teacherId, req.auth)) {
      return res.status(403).json({ message: "Accès non autorisé à cette classe" });
    }

    const parsedStartDate = parseStartDateInput(startDateInput);
    if (!parsedStartDate) {
      return res.status(400).json({ message: "Date de debut invalide" });
    }

    const [overview, weekMap] = await Promise.all([
      readPersistedProgramCOverview(),
      readCalendarWeekMapFromFile()
    ]);

    const scheduleBySubAcquis = buildScheduleBySubAcquis({
      overview,
      weekMap,
      startDate: parsedStartDate
    });

    classRoom.scheduleStartDate = parsedStartDate;
    classRoom.accessScheduleBySubAcquis = new Map<string, Date>(
      Object.entries(scheduleBySubAcquis).map(([subAcquisId, isoValue]) => [
        encodeScheduleStorageKey(subAcquisId),
        new Date(isoValue)
      ])
    );
    await classRoom.save();

    res.status(200).json({
      classRoom: {
        id: String(classRoom._id),
        name: classRoom.name,
        teacherId: String(classRoom.teacherId),
        teacherName: classRoom.teacherName,
        accessByModule: toAccessRecord(classRoom.accessByModule),
        scheduleStartDate: toIsoDateOrNull(classRoom.scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord(classRoom.accessScheduleBySubAcquis)
      },
      generatedCount: Object.keys(scheduleBySubAcquis).length
    });
  } catch (error) {
    console.error("Failed to generate class schedule:", error);
    res.status(500).json({ message: "Impossible de generer le calendrier de la classe" });
  }
});

// Reschedules EVERY class platform-wide, so — unlike the single-class
// /schedule route above — per-class ownership can't apply here; admin-only.
organizationRouter.post("/api/backoffice/classes/schedule-all", requireRole("admin"), async (req, res) => {
  try {
    const startDateInput = typeof req.body?.startDate === "string" ? req.body.startDate.trim() : "";
    if (!startDateInput) {
      return res.status(400).json({ message: "startDate est requis" });
    }

    const parsedStartDate = parseStartDateInput(startDateInput);
    if (!parsedStartDate) {
      return res.status(400).json({ message: "Date de debut invalide" });
    }

    const [overview, weekMap, classRooms] = await Promise.all([
      readPersistedProgramCOverview(),
      readCalendarWeekMapFromFile(),
      ClassRoom.find()
    ]);

    const scheduleBySubAcquis = buildScheduleBySubAcquis({
      overview,
      weekMap,
      startDate: parsedStartDate
    });

    for (const classRoom of classRooms) {
      classRoom.scheduleStartDate = parsedStartDate;
      classRoom.accessScheduleBySubAcquis = new Map<string, Date>(
        Object.entries(scheduleBySubAcquis).map(([subAcquisId, isoValue]) => [
          encodeScheduleStorageKey(subAcquisId),
          new Date(isoValue)
        ])
      );
      await classRoom.save();
    }

    const refreshedClasses = await ClassRoom.find().sort({ name: 1 }).lean();

    res.status(200).json({
      updatedClassCount: refreshedClasses.length,
      generatedCount: Object.keys(scheduleBySubAcquis).length,
      classes: refreshedClasses.map((room) => ({
        id: String(room._id),
        name: room.name,
        teacherId: room.teacherId ? String(room.teacherId) : "",
        teacherName: room.teacherName || "Enseignant non assigne",
        accessByModule: toAccessRecord((room as any).accessByModule),
        scheduleStartDate: toIsoDateOrNull((room as any).scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord((room as any).accessScheduleBySubAcquis)
      }))
    });
  } catch (error) {
    console.error("Failed to generate global class schedule:", error);
    res.status(500).json({ message: "Impossible de generer le calendrier global" });
  }
});

/**
 * GET /api/backoffice/students/:studentId/profile
 *
 * Combined per-student detail view for a teacher: the same mastery summary
 * the student sees on their own dashboard (overall %, weak sous-acquis with
 * their blocking prerequisite), an attention summary (average focus, trend
 * across sessions), and the same early-warning prediction (catch-up
 * probability, predicted grade) already computed for the roster overview.
 *
 * Scoped like every other single-student route here: an admin can look up
 * anyone, a teacher only a student in one of their own classes — never by
 * student id alone, which would let one teacher read another's roster.
 */
organizationRouter.get("/api/backoffice/students/:studentId/profile", async (req, res) => {
  try {
    const studentId = String(req.params.studentId || "").trim();
    if (!mongoose.isValidObjectId(studentId)) {
      return res.status(400).json({ message: "Identifiant etudiant invalide" });
    }

    const student = await StudentProfile.findById(studentId).lean();
    if (!student) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const classRoom = student.classId ? await ClassRoom.findById(student.classId).lean() : null;
    if (req.auth?.role !== "admin") {
      if (!classRoom || !isOwnedByCaller((classRoom as any).teacherId, req.auth)) {
        return res.status(403).json({ message: "Accès non autorisé à cet étudiant" });
      }
    }

    const identifier = String((student as any).identifier || "").trim();
    if (!identifier) {
      return res.status(404).json({ message: "Etudiant sans identifiant de connexion" });
    }

    const user = await User.findOne({ identifier })
      .select({ progress: 1 })
      .lean();

    const [orgTotalSubAcquis, masterySummary] = await Promise.all([
      resolveTotalSubAcquisCount(),
      computeStudentMasterySummary(identifier)
    ]);

    const features = extractMLFeatures({
      progress: (user as any)?.progress,
      profile: student as any,
      totalSubAcquis: orgTotalSubAcquis,
      scheduleStartDate: (classRoom as any)?.scheduleStartDate || null
    });
    // The roster overview uses the cheaper predictBatch (no SHAP) since it
    // scores a whole class at once; this single-student panel can afford the
    // real /explain call, which is what gives a teacher the factors behind
    // the number instead of a bare probability.
    let explanation: RiskExplanation | null = null;
    try {
      explanation = await resolveRiskExplanation(features);
    } catch (predictionError) {
      console.error("Prediction/explanation unavailable for student profile:", predictionError);
    }

    // Attention analytics is a batch endpoint on the Python side; called here
    // with a single-student array, same as the class-wide dashboard does with
    // the whole roster (routes/backoffice/attention.ts).
    const sessions = Array.isArray((user as any)?.progress?.attentionSessions)
      ? [...(user as any).progress.attentionSessions].sort(
          (a: any, b: any) => new Date(a.completedAt || 0).getTime() - new Date(b.completedAt || 0).getTime()
        )
      : [];
    let attention: { avgFocusScore: number | null; trend: string | null; totalSessions: number } = {
      avgFocusScore: null,
      trend: null,
      totalSessions: 0
    };
    if (sessions.length > 0) {
      try {
        const [analytics] = await computeAttentionAnalytics([
          {
            avgScores: sessions.map((s: any) => Number(s.avgFocusScore) || 0),
            distractions: sessions
              .flatMap((s: any) => (Array.isArray(s.distractionEvents) ? s.distractionEvents : []))
              .map((e: any) => String(e?.reason || ""))
              .filter(Boolean)
          }
        ]);
        attention = {
          avgFocusScore: Number((user as any)?.progress?.avgFocusScore ?? null),
          trend: (analytics as any)?.trend ?? null,
          totalSessions: sessions.length
        };
      } catch (attentionError) {
        // Attention is a supplementary signal — its own service being down
        // should not take out the rest of the profile panel.
        console.error("Attention analytics unavailable for student profile:", attentionError);
      }
    }

    res.status(200).json({
      id: String(student._id),
      fullName: (student as any).fullName || identifier,
      identifier,
      className: classRoom ? (classRoom as any).name : null,
      mastery: masterySummary
        ? { overallPct: masterySummary.overallMasteryPct, revise: masterySummary.revise }
        : null,
      attention,
      catchupProbability: explanation?.catchupProbability ?? null,
      predictedGrade: explanation?.predictedGrade ?? null,
      riskFactors: explanation?.riskFactors ?? [],
      gradeFactors: explanation?.gradeFactors ?? []
    });
  } catch (error) {
    console.error("Failed to build student profile:", error);
    res.status(500).json({ message: "Impossible de charger le profil de cet étudiant" });
  }
});

/**
 * GET /api/backoffice/students/:studentId/meetings
 *
 * A teacher's scheduled (non-cancelled) meetings with one student, most
 * recent first — shown on the profile panel so a teacher can see what is
 * already booked before scheduling another one.
 */
organizationRouter.get("/api/backoffice/students/:studentId/meetings", async (req, res) => {
  try {
    const studentId = String(req.params.studentId || "").trim();
    if (!mongoose.isValidObjectId(studentId)) {
      return res.status(400).json({ message: "Identifiant etudiant invalide" });
    }

    const student = await StudentProfile.findById(studentId).lean();
    if (!student) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const classRoom = student.classId ? await ClassRoom.findById(student.classId).lean() : null;
    if (req.auth?.role !== "admin") {
      if (!classRoom || !isOwnedByCaller((classRoom as any).teacherId, req.auth)) {
        return res.status(403).json({ message: "Accès non autorisé à cet étudiant" });
      }
    }

    const meetings = await Meeting.find({
      studentIdentifier: (student as any).identifier,
      status: "scheduled",
      // Same cutoff as the student's own list (routes/web/learning.routes.ts):
      // without this a meeting that already happened, but was never marked
      // cancelled, would sit here forever looking like it's still upcoming.
      scheduledAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    })
      .sort({ scheduledAt: 1 })
      .lean();

    res.status(200).json({
      meetings: meetings.map((m: any) => ({
        id: String(m._id),
        scheduledAt: m.scheduledAt,
        mode: m.mode,
        location: m.location,
        note: m.note || null,
        teacherName: m.teacherName
      }))
    });
  } catch (error) {
    console.error("Failed to list student meetings:", error);
    res.status(500).json({ message: "Impossible de charger les rendez-vous" });
  }
});

/**
 * POST /api/backoffice/students/:studentId/meetings
 *
 * Schedules a meeting with one student. Deliberately minimal: no
 * accept/decline, no reminders — the student simply sees it appear on
 * their calendar.
 */
organizationRouter.post("/api/backoffice/students/:studentId/meetings", async (req, res) => {
  try {
    const studentId = String(req.params.studentId || "").trim();
    if (!mongoose.isValidObjectId(studentId)) {
      return res.status(400).json({ message: "Identifiant etudiant invalide" });
    }

    const scheduledAtRaw = typeof req.body?.scheduledAt === "string" ? req.body.scheduledAt.trim() : "";
    const mode = req.body?.mode === "online" || req.body?.mode === "in-person" ? req.body.mode : "";
    const location = typeof req.body?.location === "string" ? req.body.location.trim() : "";
    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";

    if (!scheduledAtRaw || !mode || !location) {
      return res.status(400).json({ message: "Date, mode et lieu/lien sont requis" });
    }

    const scheduledAt = new Date(scheduledAtRaw);
    if (Number.isNaN(scheduledAt.getTime())) {
      return res.status(400).json({ message: "Date invalide" });
    }

    const student = await StudentProfile.findById(studentId).lean();
    if (!student) {
      return res.status(404).json({ message: "Etudiant introuvable" });
    }

    const classRoom = student.classId ? await ClassRoom.findById(student.classId).lean() : null;
    if (req.auth?.role !== "admin") {
      if (!classRoom || !isOwnedByCaller((classRoom as any).teacherId, req.auth)) {
        return res.status(403).json({ message: "Accès non autorisé à cet étudiant" });
      }
    }

    const callerTeacherId = req.auth?.id ?? "";
    const teacher = await Teacher.findById(callerTeacherId).select({ name: 1 }).lean();

    const meeting = await Meeting.create({
      studentIdentifier: (student as any).identifier,
      teacherId: callerTeacherId,
      teacherName: teacher?.name || "Enseignant",
      scheduledAt,
      mode,
      location,
      note: note || null,
      status: "scheduled"
    });

    res.status(201).json({
      id: String(meeting._id),
      scheduledAt: meeting.scheduledAt,
      mode: meeting.mode,
      location: meeting.location,
      note: meeting.note,
      teacherName: meeting.teacherName
    });
  } catch (error) {
    console.error("Failed to schedule meeting:", error);
    res.status(500).json({ message: "Impossible de planifier le rendez-vous" });
  }
});

/**
 * DELETE /api/backoffice/meetings/:meetingId
 *
 * Cancels a meeting (soft delete — kept as status: "cancelled" rather than
 * removed, so it drops off both calendars without losing the record).
 */
organizationRouter.delete("/api/backoffice/meetings/:meetingId", async (req, res) => {
  try {
    const meetingId = String(req.params.meetingId || "").trim();
    if (!mongoose.isValidObjectId(meetingId)) {
      return res.status(400).json({ message: "Identifiant de rendez-vous invalide" });
    }

    const meeting = await Meeting.findById(meetingId);
    if (!meeting) {
      return res.status(404).json({ message: "Rendez-vous introuvable" });
    }

    if (req.auth?.role !== "admin" && String(meeting.teacherId) !== String(req.auth?.id ?? "")) {
      return res.status(403).json({ message: "Accès non autorisé à ce rendez-vous" });
    }

    meeting.status = "cancelled";
    await meeting.save();

    res.status(200).json({ id: String(meeting._id), status: meeting.status });
  } catch (error) {
    console.error("Failed to cancel meeting:", error);
    res.status(500).json({ message: "Impossible d'annuler le rendez-vous" });
  }
});

