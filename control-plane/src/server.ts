import express from "express";
import session from "express-session";
import helmet from "helmet";
import morgan from "morgan";
import csurf from "csurf";
import rateLimit from "express-rate-limit";
import path from "path";
import { nanoid } from "nanoid";
import { db, migrate } from "./db";
import { verifyLogin, requireAuth, requireRole } from "./auth";
import { runnerRouter } from "./runnerApi";
import { getDbStats, runMaintenance, scheduleMaintenance } from "./maintenance";
import {
  getNotifyConfig,
  notifyRunFinishedById,
  sendTestNotification,
} from "./notify";

const SQLiteStore = require("connect-sqlite3")(session);

declare module "express-session" {
  interface SessionData {
    user?: { id: string; email: string; role: "admin" | "operator" | "viewer" };
  }
}

migrate();
scheduleMaintenance();

const app = express();
const isProduction = process.env.NODE_ENV === "production";

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "..", "views"));

app.use(express.static(path.join(__dirname, "..", "public")));
app.use(morgan(isProduction ? "combined" : "dev"));
app.use(express.urlencoded({ extended: false }));
app.use(express.json({ limit: "1mb" }));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
      },
    },
  }),
);

// Runner API is token-based and must stay outside UI session/CSRF middleware.
app.use("/runner", runnerRouter);

app.use(
  session({
    store: new SQLiteStore({ db: "sessions.sqlite", dir: "/data" }),
    secret: process.env.SESSION_SECRET || "dev_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false, // set true when app is served directly over HTTPS
    },
  }),
);

app.use((req, res, next) => {
  res.locals.user = req.session.user;
  next();
});

const csrf = csurf();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

function parseJsonObject(value: string, fallback: Record<string, unknown>) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch {
    return fallback;
  }
}

const COMMAND_IDS = [
  "COMPOSE_UP",
  "COMPOSE_DOWN",
  "COMPOSE_PULL",
  "COMPOSE_LOGS",
  "DEPLOY",
] as const;

type CommandId = (typeof COMMAND_IDS)[number];

function isCommandId(value: unknown): value is CommandId {
  return (
    typeof value === "string" &&
    (COMMAND_IDS as readonly string[]).includes(value)
  );
}

app.get("/login", csrf, (req, res) => {
  if (req.session.user) return res.redirect("/");
  res.render("login", {
    title: "Login",
    csrfToken: req.csrfToken(),
    error: null,
  });
});

app.post("/login", loginLimiter, csrf, (req, res) => {
  const { email, password } = req.body;
  const user = verifyLogin(email, password);

  if (!user) {
    return res.status(401).render("login", {
      title: "Login",
      csrfToken: req.csrfToken(),
      error: "Email atau password salah",
    });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).send("Session error");
    req.session.user = user;
    res.redirect("/");
  });
});

app.post("/logout", requireAuth, csrf, (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/", requireAuth, csrf, (req, res) => {
  const counts = db
    .prepare("SELECT status, COUNT(*) as count FROM job_runs GROUP BY status")
    .all();
  const recentRuns = db
    .prepare("SELECT * FROM job_runs ORDER BY created_at DESC LIMIT 10")
    .all();

  res.render("dashboard", {
    title: "Dashboard",
    csrfToken: req.csrfToken(),
    counts,
    recentRuns,
    stats: getDbStats(),
    notify: getNotifyConfig(),
  });
});

app.get("/templates", requireAuth, csrf, (req, res) => {
  const templates = db
    .prepare("SELECT * FROM job_templates ORDER BY name ASC")
    .all();
  res.render("templates", {
    title: "Job Templates",
    csrfToken: req.csrfToken(),
    templates,
    commandIds: COMMAND_IDS,
  });
});

app.get(
  "/templates/new",
  requireAuth,
  requireRole("admin"),
  csrf,
  (req, res) => {
    res.render("template_form", {
      title: "New Template",
      csrfToken: req.csrfToken(),
      mode: "new",
      template: {
        name: "",
        project: "projectku",
        command_id: "COMPOSE_UP",
        timeout_sec: 600,
        default_params_json: "{}",
        allowed_roles_json: '["admin","operator"]',
      },
      commandIds: COMMAND_IDS,
    });
  },
);

app.post(
  "/templates/new",
  requireAuth,
  requireRole("admin"),
  csrf,
  (req, res) => {
    const name = String(req.body.name || "").trim();
    const project = String(req.body.project || "").trim();
    const commandId = String(req.body.command_id || "").trim();
    const timeoutSec = Number(req.body.timeout_sec || 600);
    const defaultParamsJson = String(
      req.body.default_params_json || "{}",
    ).trim();
    const allowedRolesJson = String(
      req.body.allowed_roles_json || '["admin","operator"]',
    ).trim();

    if (!name || !project || !isCommandId(commandId)) {
      return res.status(400).send("Bad request");
    }

    const timeout = Number.isFinite(timeoutSec)
      ? Math.max(1, Math.min(timeoutSec, 3600))
      : 600;
    const defaultParams = parseJsonObject(defaultParamsJson, {});
    const allowedRoles = JSON.parse(allowedRolesJson || "[]");
    if (!Array.isArray(allowedRoles))
      return res.status(400).send("Bad roles json");

    db.prepare(
      `INSERT INTO job_templates (id, name, project, command_id, allowed_roles_json, default_params_json, timeout_sec)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      name,
      project,
      commandId,
      JSON.stringify(allowedRoles),
      JSON.stringify(defaultParams),
      timeout,
    );

    res.redirect("/templates");
  },
);

app.get(
  "/templates/:id/edit",
  requireAuth,
  requireRole("admin"),
  csrf,
  (req, res) => {
    const tpl = db
      .prepare("SELECT * FROM job_templates WHERE id = ?")
      .get(req.params.id) as any;
    if (!tpl) return res.status(404).send("Template not found");

    res.render("template_form", {
      title: "Edit Template",
      csrfToken: req.csrfToken(),
      mode: "edit",
      template: tpl,
      commandIds: COMMAND_IDS,
    });
  },
);

app.post(
  "/templates/:id/edit",
  requireAuth,
  requireRole("admin"),
  csrf,
  (req, res) => {
    const tpl = db
      .prepare("SELECT * FROM job_templates WHERE id = ?")
      .get(req.params.id) as any;
    if (!tpl) return res.status(404).send("Template not found");

    const name = String(req.body.name || "").trim();
    const project = String(req.body.project || "").trim();
    const commandId = String(req.body.command_id || "").trim();
    const timeoutSec = Number(req.body.timeout_sec || tpl.timeout_sec || 600);
    const defaultParamsJson = String(
      req.body.default_params_json || tpl.default_params_json || "{}",
    ).trim();
    const allowedRolesJson = String(
      req.body.allowed_roles_json || tpl.allowed_roles_json || "[]",
    ).trim();

    if (!name || !project || !isCommandId(commandId)) {
      return res.status(400).send("Bad request");
    }

    const timeout = Number.isFinite(timeoutSec)
      ? Math.max(1, Math.min(timeoutSec, 3600))
      : 600;
    const defaultParams = parseJsonObject(defaultParamsJson, {});
    const allowedRoles = JSON.parse(allowedRolesJson || "[]");
    if (!Array.isArray(allowedRoles))
      return res.status(400).send("Bad roles json");

    db.prepare(
      `UPDATE job_templates
       SET name = ?, project = ?, command_id = ?, allowed_roles_json = ?, default_params_json = ?, timeout_sec = ?
       WHERE id = ?`,
    ).run(
      name,
      project,
      commandId,
      JSON.stringify(allowedRoles),
      JSON.stringify(defaultParams),
      timeout,
      tpl.id,
    );

    res.redirect("/templates");
  },
);

app.post(
  "/templates/:id/delete",
  requireAuth,
  requireRole("admin"),
  csrf,
  (req, res) => {
    db.prepare("DELETE FROM job_templates WHERE id = ?").run(req.params.id);
    res.redirect("/templates");
  },
);

app.post(
  "/templates/:id/run",
  requireAuth,
  requireRole("admin", "operator"),
  csrf,
  (req, res) => {
    const tpl = db
      .prepare("SELECT * FROM job_templates WHERE id = ?")
      .get(req.params.id) as any;
    if (!tpl) return res.status(404).send("Template not found");

    const allowedRoles = JSON.parse(tpl.allowed_roles_json || "[]");
    if (!allowedRoles.includes(req.session.user!.role))
      return res.status(403).send("Forbidden");

    const runId = nanoid();
    const defaultParams = parseJsonObject(tpl.default_params_json || "{}", {});

    db.prepare(
      `INSERT INTO job_runs (id, template_id, project, command_id, params_json, timeout_sec, triggered_by)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      runId,
      tpl.id,
      tpl.project,
      tpl.command_id,
      JSON.stringify(defaultParams),
      tpl.timeout_sec,
      req.session.user!.email,
    );

    res.redirect(`/runs/${runId}`);
  },
);

app.get("/runs", requireAuth, csrf, (req, res) => {
  const runs = db
    .prepare("SELECT * FROM job_runs ORDER BY created_at DESC LIMIT 100")
    .all();
  res.render("runs", { title: "Runs", csrfToken: req.csrfToken(), runs });
});

app.get("/runs/:id", requireAuth, csrf, (req, res) => {
  const run = db
    .prepare("SELECT * FROM job_runs WHERE id = ?")
    .get(req.params.id) as any;
  if (!run) return res.status(404).send("Run not found");

  const logs = db
    .prepare("SELECT * FROM job_run_logs WHERE run_id = ? ORDER BY id ASC")
    .all(req.params.id);
  res.render("run", {
    title: `Run ${run.id}`,
    csrfToken: req.csrfToken(),
    run,
    logs,
  });
});

app.post(
  "/runs/:id/cancel",
  requireAuth,
  requireRole("admin", "operator"),
  csrf,
  (req, res) => {
    const run = db
      .prepare("SELECT * FROM job_runs WHERE id = ?")
      .get(req.params.id) as any;
    if (!run) return res.status(404).send("Run not found");

    // Soft-cancel:
    // - queued: will never be claimed
    // - running: runner may check status cooperatively (best-effort)
    if (run.status !== "queued" && run.status !== "running") {
      return res.status(400).send("Run cannot be canceled");
    }

    db.prepare(
      "UPDATE job_runs SET status = 'canceled', finished_at = datetime('now') WHERE id = ?",
    ).run(req.params.id);

    notifyRunFinishedById(req.params.id);

    res.redirect(`/runs/${req.params.id}`);
  },
);

app.get("/runs/:id/logs.json", requireAuth, (req, res) => {
  const after = Number(req.query.after || 0);
  const logs = db
    .prepare(
      "SELECT * FROM job_run_logs WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 500",
    )
    .all(req.params.id, Number.isFinite(after) ? after : 0);
  res.json({ logs });
});

app.post(
  "/admin/maintenance",
  requireAuth,
  requireRole("admin"),
  csrf,
  (_req, res) => {
    try {
      const result = runMaintenance();
      console.log("[maintenance] manual run", result);
    } catch (err) {
      console.error("[maintenance] manual error", err);
    }
    res.redirect("/");
  },
);

app.post(
  "/admin/notify-test",
  requireAuth,
  requireRole("admin"),
  csrf,
  async (_req, res) => {
    try {
      const result = await sendTestNotification();
      console.log("[notify] manual test", result);
    } catch (err) {
      console.error("[notify] manual test error", err);
    }
    res.redirect("/");
  },
);

app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (err.code === "EBADCSRFTOKEN")
      return res.status(403).send("Invalid CSRF token");
    console.error(err);
    res.status(500).send("Internal server error");
  },
);

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`control-plane listening on :${PORT}`));
