/**
 * Static page routes — friendly paths that send the public/ HTML pages.
 */
import { Router } from "express";
import path from "node:path";

export const pagesRouter = Router();

pagesRouter.get("/", (_req, res) => {
  const indexPath = path.join(process.cwd(), "public", "index.html");
  res.sendFile(indexPath);
});


// Uses dedicated auth file under public/auth for organized static page structure.
pagesRouter.get("/sign-in", (_req, res) => {
  const signInPath = path.join(process.cwd(), "public", "auth", "sign-in.html");
  res.sendFile(signInPath);
});

// Forgot-password page endpoint.
pagesRouter.get("/forgot-password", (_req, res) => {
  const forgotPasswordPath = path.join(process.cwd(), "public", "auth", "forgot-password.html");
  res.sendFile(forgotPasswordPath);
});

// Reset-password page endpoint.
pagesRouter.get("/reset-password", (_req, res) => {
  const resetPasswordPath = path.join(process.cwd(), "public", "auth", "reset-password.html");
  res.sendFile(resetPasswordPath);
});

// Public sign-up route is disabled. Keep this endpoint for backward compatibility.
pagesRouter.get("/sign-up", (_req, res) => {
  res.redirect("/sign-in");
});

// Backoffice page endpoint.
// Serves the admin and teacher interface for dashboards and content management.
pagesRouter.get("/backoffice", (_req, res) => {
  const backofficePath = path.join(process.cwd(), "public", "backoffice", "index.html");
  res.sendFile(backofficePath);
});

// Student dashboard endpoint.
// Blackboard-like student area with sidebar navigation and course access.
pagesRouter.get("/student", (_req, res) => {
  const studentDashboardPath = path.join(process.cwd(), "public", "student", "index.html");
  res.sendFile(studentDashboardPath);
});

// "Mission Apprenant" learning style detection game.
pagesRouter.get("/student/mission-apprenant", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "student", "mission-apprenant.html"));
});

// ============================================
// TEACHER QUIZ GENERATION ENDPOINTS
// ============================================


// Teacher quiz generator page
pagesRouter.get("/teacher/quiz-generator", (_req, res) => {
  const quizGeneratorPath = path.join(process.cwd(), "public", "teacher", "quiz-generator.html");
  res.sendFile(quizGeneratorPath, (err: any) => {
    if (err) {
      res.status(404).send("Quiz generator page not found");
    }
  });
});
