import bcrypt from "bcrypt";
import { nanoid } from "nanoid";
import { db, migrate } from "./db";

migrate();

const email = (process.env.SEED_ADMIN_EMAIL || "admin@wanna-cry.local")
  .trim()
  .toLowerCase();
const password = process.env.SEED_ADMIN_PASSWORD || "changeme123";

const exists = db.prepare("SELECT 1 FROM users WHERE email = ?").get(email);
if (!exists) {
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
  ).run(nanoid(), email, bcrypt.hashSync(password, 10));
  console.log(`seeded admin: ${email}`);
} else {
  console.log(`admin already exists: ${email}`);
}

const templates = [
  {
    name: "Up projectku",
    project: "projectku",
    commandId: "COMPOSE_UP",
    params: {},
    timeoutSec: 600,
  },
  {
    name: "Down projectku",
    project: "projectku",
    commandId: "COMPOSE_DOWN",
    params: {},
    timeoutSec: 600,
  },
  {
    name: "Pull projectku",
    project: "projectku",
    commandId: "COMPOSE_PULL",
    params: {},
    timeoutSec: 600,
  },
  {
    name: "Logs projectku",
    project: "projectku",
    commandId: "COMPOSE_LOGS",
    params: { tailLines: 200 },
    timeoutSec: 120,
  },
];

for (const t of templates) {
  const found = db
    .prepare("SELECT 1 FROM job_templates WHERE name = ?")
    .get(t.name);
  if (!found) {
    db.prepare(
      `INSERT INTO job_templates (id, name, project, command_id, default_params_json, timeout_sec)
                VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      nanoid(),
      t.name,
      t.project,
      t.commandId,
      JSON.stringify(t.params),
      t.timeoutSec,
    );
    console.log(`seeded template: ${t.name}`);
  }
}

console.log("seed done");
