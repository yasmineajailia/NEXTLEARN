import express from "express";
import path from "node:path";
import mongoose from "mongoose";
import helmet from "helmet";
import { env } from "./config/env";
import { webRouter } from "./routes/web";
import { chatbotRouter } from "./routes/student/chatbot";
import { masteryRouter } from "./routes/student/mastery";
import { explainCheckRouter } from "./routes/student/explainCheck";
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

// Trust the first hop (cloud load balancer / reverse proxy) so req.ip and
// secure-cookie detection see the real client.
app.set("trust proxy", 1);

// Apply basic security headers. CSP is currently disabled as it conflicts with
// inline scripts/styles and external dependencies (WASM models, embeds).
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// Static assets: CSS, images, and any future client-side JavaScript.
app.use(express.static(path.join(process.cwd(), "public")));
// Static assets mounted at ASCII path to handle encoding issues.
app.use(
  "/support-cours",
  express.static(path.join(process.cwd(), "content", "Support_Cours_Préparation"))
);
// Serve graph.json from data directory
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
app.use(masteryRouter);
app.use(explainCheckRouter);
app.use(pagesRouter);
// Require teacher or admin role for all backoffice routes.
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

// Global error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return;
  res.status(500).json({ message: "Une erreur inattendue est survenue" });
});

// Process-level error handlers
process.on("uncaughtException", (err) => {
  console.error("[fatal] Uncaught exception:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[warn] Unhandled promise rejection:", reason);
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

    // Keep SHAP service running for explanations
    startShapService();

    // Chatbot RAG index runs externally.

    app.listen(env.port, () => {
      // Startup log helps confirm active environment and server port.
      console.log(`NextLearn server running on http://localhost:${env.port} (${env.nodeEnv})`);
      // Handy dev-only tool: most terminals render this as a clickable link.
      if (env.nodeEnv !== "production") {
        console.log(`Attention tracker tester: http://localhost:${env.port}/dev/attention-debug.html`);
      }
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

// Graceful shutdown: terminate supervised child process
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
