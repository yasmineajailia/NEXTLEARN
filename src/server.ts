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
// secure-cookie detection (auth.ts's `secure: env.nodeEnv === "production"`)
// see the real client, not the proxy. A bare `true` would trust the whole
// X-Forwarded-For chain, which lets a client spoof its own IP — 1 hop is
// correct for a single reverse proxy in front of the app; raise it only if
// there's genuinely more than one proxy hop between the client and this app.
app.set("trust proxy", 1);

// Safe, non-breaking hardening headers (X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, HSTS in production, etc.). Content-Security-Policy is
// deliberately OFF: this app has inline <script>/<style> blocks on nearly every
// page plus several external CDNs (Google Fonts, cdn.plyr.io, cdn.jsdelivr.net
// for MediaPipe's WASM face-tracking model, drive.google.com/officeapps.live.com
// embeds), and getting a CSP right for the WASM-loading attention tracker and
// the chatbot specifically needs real browser testing to confirm nothing silently
// breaks — not something to guess at blind. Worth a follow-up once that's possible.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));

// Static assets: CSS, images, and any future client-side JavaScript.
app.use(express.static(path.join(process.cwd(), "public")));
// Mounted at an ASCII path deliberately: Express 4 matches a mount path
// against the still percent-encoded req.url, so a literal accented character
// here (as "/Support_Cours_Préparation" used to be) never matches the
// %C3%A9-encoded form every browser actually sends, and every file under it
// 404s silently. The folder on disk keeps its accented name — only the URL
// prefix has to be ASCII.
app.use(
  "/support-cours",
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
app.use(masteryRouter);
app.use(explainCheckRouter);
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

// Last-resort error handler: every route in this codebase wraps its body in
// try/catch and responds itself, but this catches whatever slips through
// (a synchronous throw in a middleware, a future route someone forgets to
// wrap) so a single bad request 500s instead of taking the whole server down.
// Must be registered last, and Express only treats a 4-arg function as an
// error handler — do not drop `next` even though it's unused.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled request error:", err);
  if (res.headersSent) return;
  res.status(500).json({ message: "Une erreur inattendue est survenue" });
});

// Process-level safety net. uncaughtException means Node's state may be
// corrupted, so we log and exit — Docker's `restart: unless-stopped` brings it
// back clean. unhandledRejection is logged but not fatal: with every route
// already try/catch'd, one reaching here is most likely a minor background
// task (e.g. a fire-and-forget stat update) failing quietly, not a reason to
// drop every other student's in-flight request.
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
