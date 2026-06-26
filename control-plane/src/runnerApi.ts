import { Router } from "express";
import { db } from "./db";

const RUNNER_TOKEN = process.env.RUNNER_TOKEN || "";

function runnerAuth(req: any, res: any, next: any) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!RUNNER_TOKEN || token !== RUNNER_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

export const runnerRouter = Router();
runnerRouter.use(runnerAuth);

// Read-only status endpoint for cooperative cancellation.
runnerRouter.get("/run/:id", (req, res) => {
  const run = db
    .prepare("SELECT id, status FROM job_runs WHERE id = ?")
    .get(req.params.id) as any;
  if (!run) return res.status(404).json({ error: "not_found" });
  res.json({ runId: run.id, status: run.status });
});

runnerRouter.post("/claim", (_req, res) => {
  const claim = db.transaction(() => {
    const job = db
      .prepare(
        "SELECT * FROM job_runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
      )
      .get() as any;

    if (!job) return null;

    db.prepare(
      "UPDATE job_runs SET status = 'running', started_at = datetime('now') WHERE id = ? AND status = 'queued'",
    ).run(job.id);

    return job;
  });

  const job = claim();
  if (!job) return res.status(204).end();

  res.json({
    runId: job.id,
    project: job.project,
    commandId: job.command_id,
    params: JSON.parse(job.params_json || "{}"),
    timeoutSec: job.timeout_sec,
  });
});

runnerRouter.post("/log", (req, res) => {
  const { runId, stream, chunk } = req.body || {};
  const safeStream = stream === "stderr" ? "stderr" : "stdout";

  if (!runId || typeof chunk !== "string") {
    return res.status(400).json({ error: "bad_request" });
  }

  // Cap a single chunk to avoid accidental giant rows.
  const safeChunk = chunk.slice(0, 16_000);
  db.prepare(
    "INSERT INTO job_run_logs (run_id, stream, chunk) VALUES (?, ?, ?)",
  ).run(runId, safeStream, safeChunk);
  res.json({ ok: true });
});

runnerRouter.post("/finish", (req, res) => {
  const { runId, status, exitCode } = req.body || {};
  const allowed = ["success", "failed", "timeout", "canceled"];

  if (!runId || !allowed.includes(status)) {
    return res.status(400).json({ error: "bad_request" });
  }

  db.prepare(
    "UPDATE job_runs SET status = ?, exit_code = ?, finished_at = datetime('now') WHERE id = ?",
  ).run(status, typeof exitCode === "number" ? exitCode : null, runId);

  res.json({ ok: true });
});
