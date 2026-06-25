import Database from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";

const DB_PATH = (
  process.env.DATABASE_URL || "file:/data/wannacry.sqlite"
).replace(/^file:/, "");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export type JobStatus = "queued" | "running" | "success" | "failed" | "timeout";

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'operator',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project TEXT NOT NULL,
      command_id TEXT NOT NULL,
      allowed_roles_json TEXT NOT NULL DEFAULT '["admin","operator"]',
      default_params_json TEXT NOT NULL DEFAULT '{}',
      timeout_sec INTEGER NOT NULL DEFAULT 600,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      project TEXT NOT NULL,
      command_id TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '{}',
      timeout_sec INTEGER NOT NULL DEFAULT 600,
      status TEXT NOT NULL DEFAULT 'queued',
      exit_code INTEGER,
      triggered_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY(template_id) REFERENCES job_templates(id)
    );

    CREATE TABLE IF NOT EXISTS job_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      stream TEXT NOT NULL CHECK(stream IN ('stdout', 'stderr')),
      chunk TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES job_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_runs_status_created ON job_runs(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_logs_run_id ON job_run_logs(run_id, id);
  `);
}
