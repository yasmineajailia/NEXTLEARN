/**
 * shapSupervisor.ts
 *
 * Keeps the Python SHAP microservice (ml/shap_service.py) running for the whole
 * lifetime of the Node server, so canonical shap.TreeExplainer explanations are
 * ALWAYS the primary source — not an optional extra you start by hand.
 *
 * Behaviour:
 *   - If a healthy SHAP service is already listening (e.g. started manually or
 *     left over from a `tsx watch` reload), it is adopted, not duplicated.
 *   - Otherwise `python ml/shap_service.py` is spawned and its /health endpoint
 *     is polled until it answers.
 *   - If the child exits unexpectedly it is restarted with exponential backoff
 *     (capped), so a transient crash self-heals and a broken Python environment
 *     retries periodically instead of spinning.
 *   - The in-process JS exact-Shapley path in explain.ts remains as a crash
 *     guard for the brief windows when the service is (re)starting.
 *
 * Override the Python executable with PYTHON_BIN, the port with SHAP_PORT.
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { SHAP_SERVICE_URL, markShapServiceUp, markShapServiceDown } from "./explain";

const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const SHAP_PORT = process.env.SHAP_PORT || "8000";
const SCRIPT = path.join(process.cwd(), "ml", "shap_service.py");
const HEALTH_URL = `${SHAP_SERVICE_URL.replace(/\/$/, "")}/health`;

const HEALTH_POLL_INTERVAL_MS = 600;
const HEALTH_POLL_TIMEOUT_MS = 40_000; // shap + pandas + numpy import can be slow on first boot
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const MONITOR_INTERVAL_MS = 15_000;

let child: ChildProcess | null = null;
let stopped = false;
let restartAttempts = 0;
let restartTimer: NodeJS.Timeout | null = null;
let monitorTimer: NodeJS.Timeout | null = null;
/** True when we adopted an externally-managed service and must not kill it. */
let adopted = false;

async function pingHealth(timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealthy(): Promise<boolean> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline && !stopped) {
    if (await pingHealth()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
  }
  return false;
}

function scheduleRestart(): void {
  if (stopped || restartTimer) return;
  const delay = Math.min(BACKOFF_MIN_MS * 2 ** restartAttempts, BACKOFF_MAX_MS);
  restartAttempts += 1;
  console.warn(`[shap] service down — restarting in ${Math.round(delay / 1000)}s (attempt ${restartAttempts})`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void spawnAndWatch();
  }, delay);
}

async function spawnAndWatch(): Promise<void> {
  if (stopped) return;

  // Reuse an already-running service instead of fighting over the port.
  if (await pingHealth()) {
    adopted = child === null;
    markShapServiceUp();
    restartAttempts = 0;
    if (adopted) console.log(`[shap] adopted existing SHAP service at ${SHAP_SERVICE_URL}`);
    return;
  }

  adopted = false;
  child = spawn(PYTHON_BIN, [SCRIPT], {
    cwd: process.cwd(),
    env: { ...process.env, SHAP_PORT },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"]
  });

  child.stderr?.on("data", (buf: Buffer) => {
    const line = buf.toString().trimEnd();
    if (line) process.stderr.write(`[shap] ${line}\n`);
  });

  child.on("error", (err) => {
    console.error(`[shap] failed to launch "${PYTHON_BIN} ml/shap_service.py":`, err.message);
    console.error("[shap] install deps with: npm run shap:install (or set PYTHON_BIN)");
  });

  child.on("exit", (code, signal) => {
    child = null;
    markShapServiceDown();
    if (stopped) return;
    console.warn(`[shap] service exited (code ${code ?? "?"}, signal ${signal ?? "none"})`);
    scheduleRestart();
  });

  if (await waitForHealthy()) {
    markShapServiceUp();
    restartAttempts = 0;
    console.log(`[shap] service ready at ${SHAP_SERVICE_URL} (canonical TreeExplainer active)`);
  } else if (!stopped) {
    console.warn("[shap] service did not become healthy in time; JS exact-Shapley is covering until it does");
    // The exit handler (or the next tick) will schedule a retry if the child died.
    if (!child) scheduleRestart();
  }
}

/**
 * Periodic safety net: if we aren't managing a live child and the service isn't
 * answering (e.g. an adopted instance died, or a hot-reload race), take over by
 * (re)spawning. When we do manage a child, its own exit handler covers restarts.
 */
async function monitorTick(): Promise<void> {
  if (stopped || child || restartTimer) return;
  if (!(await pingHealth())) {
    markShapServiceDown();
    void spawnAndWatch();
  }
}

/** Launches (or adopts) the SHAP service and keeps it alive. Call once at server startup. */
export function startShapService(): void {
  stopped = false;
  restartAttempts = 0;
  void spawnAndWatch();
  if (!monitorTimer) {
    monitorTimer = setInterval(() => void monitorTick(), MONITOR_INTERVAL_MS);
    monitorTimer.unref?.();
  }
}

/** Stops supervising and terminates a child we launched. Safe to call on shutdown. */
export function stopShapService(): void {
  stopped = true;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  if (child && !adopted) {
    child.kill();
    child = null;
  }
}
