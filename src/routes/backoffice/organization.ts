/**
 * Back-office organization management: teachers, classes, students,
 * module access rules and unlock schedules.
 */
import { Router } from "express";
import mongoose from "mongoose";
import { User } from "../../models/User";
import { Teacher } from "../../models/Teacher";
import { ClassRoom } from "../../models/ClassRoom";
import { StudentProfile } from "../../models/StudentProfile";
import { hashPassword } from "../../utils/password";
import { MLPredictorService } from "../../services/MLPredictorService";
import { extractMLFeatures } from "../../services/prediction/features";
import { computeModuleQuizScores, computeStudentProgress } from "../../services/studentProgress";
import {
  buildScheduleBySubAcquis,
  encodeScheduleStorageKey,
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
    // Resolve the caller's identity from the X-Teacher-Id header
    const requestedTeacherId = String(req.headers["x-teacher-id"] || "").trim();
    let callerIsAdmin = false;
    let callerTeacherId = "";

    if (requestedTeacherId && mongoose.Types.ObjectId.isValid(requestedTeacherId)) {
      const caller = await Teacher.findById(requestedTeacherId).select({ role: 1 }).lean();
      if (caller) {
        callerIsAdmin = String((caller as any).role || "").toLowerCase() === "admin";
        callerTeacherId = requestedTeacherId;
      }
    } else {
      // No valid ID supplied — treat as admin so existing integrations keep working
      callerIsAdmin = true;
    }

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

    res.status(200).json({
      teachers: teachers.map((teacher) => ({
        id: String(teacher._id),
        role: teacher.role || "enseignant",
        name: teacher.name,
        email: teacher.email || "",
        phone: teacher.phone || ""
      })),
      classes: classes.map((room) => ({
        id: String(room._id),
        name: room.name,
        teacherId: room.teacherId ? String(room.teacherId) : "",
        teacherName: room.teacherName || "Enseignant non assigne",
        accessByModule: toAccessRecord((room as any).accessByModule),
        scheduleStartDate: toIsoDateOrNull(room.scheduleStartDate),
        accessScheduleBySubAcquis: toScheduleIsoRecord((room as any).accessScheduleBySubAcquis)
      })),
      students: students.map((student) => {
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
        const catchupProbability = MLPredictorService.predict(features);

        return {
          id: String(student._id),
          fullName: student.fullName,
          identifier,
          email: student.email || "",
          classId: student.classId ? String(student.classId) : "",
          lessonsCompleted: stats?.lessonsCompleted ?? Number(student.lessonsCompleted || 0),
          quizzesTaken: stats?.quizzesPassed ?? Number(student.quizzesTaken || 0),
          averageQuizGrade: stats?.averageQuizScoreOn20 ?? Number(student.averageQuizGrade || 0),
          catchupProbability,
          lastLoginDate: (prof as any)?.lastLoginDate ? new Date((prof as any).lastLoginDate).toISOString() : null,
          quizScoresByModule: computeModuleQuizScores((user as any)?.progress?.quizResults)
        };
      })
    });
  } catch (error) {
    console.error("Failed to load backoffice organization:", error);
    res.status(500).json({ message: "Impossible de charger l'organisation" });
  }
});

organizationRouter.post("/api/backoffice/teachers", async (req, res) => {
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

organizationRouter.put("/api/backoffice/teachers/:teacherId", async (req, res) => {
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

organizationRouter.delete("/api/backoffice/teachers/:teacherId", async (req, res) => {
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

// Returns the classes visible to the caller (resolved from the X-Teacher-Id
// header, same convention as /api/backoffice/organization), each annotated
// with its live student count. Used by the clustering dashboard's class
// selector.
organizationRouter.get("/api/backoffice/classes", async (req, res) => {
  try {
    const requestedTeacherId = String(req.headers["x-teacher-id"] || "").trim();
    let callerIsAdmin = false;
    let callerTeacherId = "";

    if (requestedTeacherId && mongoose.Types.ObjectId.isValid(requestedTeacherId)) {
      const caller = await Teacher.findById(requestedTeacherId).select({ role: 1 }).lean();
      if (caller) {
        callerIsAdmin = String((caller as any).role || "").toLowerCase() === "admin";
        callerTeacherId = requestedTeacherId;
      }
    } else {
      // No valid ID supplied — treat as admin so existing integrations keep working.
      callerIsAdmin = true;
    }

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

organizationRouter.post("/api/backoffice/classes/schedule-all", async (req, res) => {
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

