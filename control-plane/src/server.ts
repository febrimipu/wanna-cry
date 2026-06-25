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

const SQLiteStore = require("connect-sqlite3")(session);

declare module "express-session" {
  interface SessionData {
    user?: { id: string; email: string; role: "admin" | "operator" | "viewer" };
  }
}

migrate();

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
  });
});

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

app.get("/runs/:id/logs.json", requireAuth, (req, res) => {
  const after = Number(req.query.after || 0);
  const logs = db
    .prepare(
      "SELECT * FROM job_run_logs WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 500",
    )
    .all(req.params.id, Number.isFinite(after) ? after : 0);
  res.json({ logs });
});

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
