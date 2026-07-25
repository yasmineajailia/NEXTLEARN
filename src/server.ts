import express from "express";
import path from "node:path";
import mongoose from "mongoose";
import { env } from "./config/env";
import { webRouter } from "./routes/web";
import { chatbotRouter } from "./routes/student/chatbot";
import { organizationRouter } from "./routes/backoffice/organization";
import { pagesRouter } from "./routes/pages";
import { clusteringRouter } from "./routes/backoffice/clustering";
import { attentionRouter } from "./routes/backoffice/attention";
import { varkRouter } from "./routes/backoffice/vark";
import { attentionSessionRouter } from "./routes/student/attentionSession";
import { requireRole } from "./middleware/auth";
import { MLPredictorService } from "./services/MLPredictorService";
import { startShapService, stopShapService } from "./services/prediction/shapSupervisor";

// App bootstrap.
// Express serves static files from public/ and API/page routes from webRouter.
const app = express();

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// Static assets: CSS, images, and any future client-side JavaScript.
app.use(express.static(path.join(process.cwd(), "public")));
app.use(
  "/Support_Cours_Préparation",
  express.static(path.join(process.cwd(), "content", "Support_Cours_Préparation"))
);
// The physical file lives in data/, but the public URL stays /graph.json so no
// client fetch has to change.
app.get("/graph.json", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "data", "graph.json"));
});
app.use(
  "/vendor/pdfjs",
  express.static(path.join(process.cwd(), "node_modules", "pdfjs-dist", "build"))
);

// App routes.
app.use(webRouter);
app.use(chatbotRouter);
app.use(pagesRouter);
// Every backoffice endpoint requires a verified teacher/admin session. One guard
// covers all three routers because they all live under /api/backoffice. This is
// what closes the old "no X-Teacher-Id header => treated as admin" backdoor.
app.use("/api/backoffice", requireRole("enseignant", "admin"));
app.use(organizationRouter);
app.use(clusteringRouter);
app.use(attentionRouter);
app.use(varkRouter);
app.use(attentionSessionRouter);

// Friendly 404 fallback for unknown routes.
app.use((_req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// MongoDB connection
async function startServer() {
  try {
    if (!env.mongodbUri) {
      throw new Error("MONGODB_URI environment variable is not set");
    }

    await mongoose.connect(env.mongodbUri);
    console.log("Connected to MongoDB");

    // Train the ML model asynchronously – does not block startup.
    void MLPredictorService.initialize().catch((err) =>
      console.error("[ML] Failed to initialize ML predictor:", err)
    );

    // Keep the Python SHAP microservice running for the whole server lifetime so
    // canonical TreeExplainer explanations are always the primary source. The
    // in-process JS exact-Shapley path only covers the brief (re)start windows.
    startShapService();

    // The chatbot RAG index (ChromaDB) is owned + persisted by the Python service,
    // so there is no boot-time warm-up here. Populate/refresh it with
    // `npm run reindex:rag`; curriculum saves also trigger a background reindex.

    app.listen(env.port, () => {
      // Startup log helps confirm active environment and server port.
      console.log(`NextLearn server running on http://localhost:${env.port} (${env.nodeEnv})`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Terminate the supervised SHAP child on shutdown (including `tsx watch` reloads,
// which send SIGTERM to the old process) so it doesn't leak or hold port 8000.
let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopShapService();
  process.exit(signal === "SIGINT" ? 130 : 0);
}
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("exit", () => stopShapService());

startServer();
