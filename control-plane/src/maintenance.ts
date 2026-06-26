import { statSync } from "fs";
import { db } from "./db";

// All retention values are configurable via env. Defaults are conservative
// so a small VPS tidak penuh dalam beberapa minggu.
const MAX_LOG_LINES_PER_RUN = Math.max(
  100,
  Number(process.env.MAX_LOG_LINES_PER_RUN || 5000),
);
const LOG_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.LOG_RETENTION_DAYS || 30),
);
const RUN_RETENTION_DAYS = Math.max(
  LOG_RETENTION_DAYS,
  Number(process.env.RUN_RETENTION_DAYS || 90),
);
const MAINTENANCE_INTERVAL_HOURS = Math.max(
  1,
  Number(process.env.MAINTENANCE_INTERVAL_HOURS || 24),
);

const DB_PATH = (
  process.env.DATABASE_URL || "file:/data/wannacry.sqlite"
).replace(/^file:/, "");

export type MaintenanceResult = {
  startedAt: string;
  finishedAt: string;
  trimmedLogRows: number;
  deletedOldLogRows: number;
  deletedOldRuns: number;
  vacuumed: boolean;
  walCheckpointed: boolean;
  dbSizeBytesBefore: number;
  dbSizeBytesAfter: number;
};

function safeStatSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function getDbStats() {
  const dbSize = safeStatSize(DB_PATH);
  const walSize = safeStatSize(`${DB_PATH}-wal`);
  const runs = db.prepare("SELECT COUNT(*) as n FROM job_runs").get() as {
    n: number;
  };
  const logs = db.prepare("SELECT COUNT(*) as n FROM job_run_logs").get() as {
    n: number;
  };
  return {
    dbSizeBytes: dbSize,
    walSizeBytes: walSize,
    totalRuns: runs.n,
    totalLogRows: logs.n,
    config: {
      maxLogLinesPerRun: MAX_LOG_LINES_PER_RUN,
      logRetentionDays: LOG_RETENTION_DAYS,
      runRetentionDays: RUN_RETENTION_DAYS,
      intervalHours: MAINTENANCE_INTERVAL_HOURS,
    },
  };
}

/**
 * Run all maintenance tasks. Safe to call concurrently with normal traffic;
 * deletes are bounded and indexed.
 */
export function runMaintenance(): MaintenanceResult {
  const startedAt = new Date().toISOString();
  const dbSizeBytesBefore = safeStatSize(DB_PATH);

  // 1) Trim per-run logs to the latest N rows. Uses indexed (run_id, id).
  const trimStmt = db.prepare(`
    DELETE FROM job_run_logs
    WHERE run_id = ?
      AND id NOT IN (
        SELECT id FROM job_run_logs
        WHERE run_id = ?
        ORDER BY id DESC
        LIMIT ?
      )
  `);
  const noisyRuns = db
    .prepare(
      `SELECT run_id, COUNT(*) as n
       FROM job_run_logs
       GROUP BY run_id
       HAVING n > ?`,
    )
    .all(MAX_LOG_LINES_PER_RUN) as Array<{ run_id: string; n: number }>;
  let trimmedLogRows = 0;
  const trimTx = db.transaction((rows: typeof noisyRuns) => {
    for (const r of rows) {
      const info = trimStmt.run(r.run_id, r.run_id, MAX_LOG_LINES_PER_RUN);
      trimmedLogRows += Number(info.changes || 0);
    }
  });
  trimTx(noisyRuns);

  // 2) Delete logs that belong to runs older than LOG_RETENTION_DAYS.
  const deletedOldLogs = db
    .prepare(
      `DELETE FROM job_run_logs
       WHERE run_id IN (
         SELECT id FROM job_runs
         WHERE created_at < datetime('now', ?)
       )`,
    )
    .run(`-${LOG_RETENTION_DAYS} days`);
  const deletedOldLogRows = Number(deletedOldLogs.changes || 0);

  // 3) Delete job_runs (and their remaining logs via CASCADE) older than
  // RUN_RETENTION_DAYS. Only runs that are already terminal — never wipe
  // queued/running.
  const deletedRuns = db
    .prepare(
      `DELETE FROM job_runs
       WHERE created_at < datetime('now', ?)
         AND status IN ('success','failed','timeout','canceled')`,
    )
    .run(`-${RUN_RETENTION_DAYS} days`);
  const deletedOldRuns = Number(deletedRuns.changes || 0);

  // 4) Checkpoint WAL (truncate) and VACUUM to actually reclaim disk.
  let walCheckpointed = false;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    walCheckpointed = true;
  } catch {
    walCheckpointed = false;
  }

  let vacuumed = false;
  try {
    // VACUUM cannot run inside a transaction; better-sqlite3 exec is fine here.
    db.exec("VACUUM;");
    vacuumed = true;
  } catch {
    vacuumed = false;
  }

  const finishedAt = new Date().toISOString();
  const dbSizeBytesAfter = safeStatSize(DB_PATH);

  return {
    startedAt,
    finishedAt,
    trimmedLogRows,
    deletedOldLogRows,
    deletedOldRuns,
    vacuumed,
    walCheckpointed,
    dbSizeBytesBefore,
    dbSizeBytesAfter,
  };
}

let scheduled = false;

/**
 * Schedule maintenance: jalan sekali saat startup (delay singkat agar request
 * pertama tidak terblok), lalu setiap MAINTENANCE_INTERVAL_HOURS.
 */
export function scheduleMaintenance() {
  if (scheduled) return;
  scheduled = true;

  const intervalMs = MAINTENANCE_INTERVAL_HOURS * 60 * 60 * 1000;

  setTimeout(() => {
    try {
      const result = runMaintenance();
      console.log("[maintenance] startup run", result);
    } catch (err) {
      console.error("[maintenance] startup error", err);
    }
  }, 30_000);

  setInterval(() => {
    try {
      const result = runMaintenance();
      console.log("[maintenance] periodic run", result);
    } catch (err) {
      console.error("[maintenance] periodic error", err);
    }
  }, intervalMs);
}
