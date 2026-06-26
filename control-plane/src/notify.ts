import { db } from "./db";

const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL || "";
const NOTIFY_WEBHOOK_TYPE = (process.env.NOTIFY_WEBHOOK_TYPE ||
  "auto") as NotifyType;
const NOTIFY_PUBLIC_URL = (process.env.NOTIFY_PUBLIC_URL || "").replace(
  /\/$/,
  "",
);
const NOTIFY_ON = (process.env.NOTIFY_ON || "failed,timeout,canceled")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const NOTIFY_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.NOTIFY_TIMEOUT_MS || 5000),
);

type NotifyType = "auto" | "slack" | "discord" | "generic";
type ResolvedType = "slack" | "discord" | "generic";

function detectType(url: string): ResolvedType {
  if (NOTIFY_WEBHOOK_TYPE !== "auto")
    return NOTIFY_WEBHOOK_TYPE as ResolvedType;
  if (url.includes("hooks.slack.com")) return "slack";
  if (
    url.includes("discord.com/api/webhooks") ||
    url.includes("discordapp.com/api/webhooks")
  )
    return "discord";
  return "generic";
}

export type NotifyRunRow = {
  id: string;
  project: string;
  command_id: string;
  status: string;
  exit_code: number | null;
  triggered_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

function statusEmoji(status: string) {
  switch (status) {
    case "success":
      return "\u2705"; // ✅
    case "failed":
      return "\u274C"; // ❌
    case "timeout":
      return "\u23F1\uFE0F"; // ⏱️
    case "canceled":
      return "\u26D4"; // ⛔
    default:
      return "\u2139\uFE0F"; // ℹ️
  }
}

function runLink(runId: string) {
  return NOTIFY_PUBLIC_URL
    ? `${NOTIFY_PUBLIC_URL}/runs/${runId}`
    : `/runs/${runId}`;
}

function buildPayload(run: NotifyRunRow, type: ResolvedType) {
  const emoji = statusEmoji(run.status);
  const link = runLink(run.id);
  const headline = `${emoji} ${run.command_id} on ${run.project} — ${run.status.toUpperCase()}`;
  const detailLines = [
    `run: ${run.id}`,
    `by: ${run.triggered_by || "-"}`,
    `exit: ${run.exit_code === null ? "-" : run.exit_code}`,
    `started: ${run.started_at || "-"}`,
    `finished: ${run.finished_at || "-"}`,
    `link: ${link}`,
  ];

  if (type === "slack") {
    return {
      text: `*${headline}*\n\`\`\`\n${detailLines.join("\n")}\n\`\`\``,
    };
  }
  if (type === "discord") {
    return {
      content: `**${headline}**\n\`\`\`\n${detailLines.join("\n")}\n\`\`\``,
    };
  }
  // Generic: send the full run row + a friendly summary.
  return {
    event: "job_run_finished",
    summary: headline,
    link,
    run,
  };
}

async function sendWebhook(payload: unknown): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  if (!NOTIFY_WEBHOOK_URL) return { ok: false, error: "webhook_disabled" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
  try {
    const res = await fetch(NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[notify] webhook non-2xx", res.status, body.slice(0, 200));
      return { ok: false, status: res.status, error: body.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err: any) {
    const msg =
      err?.name === "AbortError" ? "timeout" : String(err?.message || err);
    console.warn("[notify] webhook error", msg);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget notify for a finished/canceled run. Reads the latest row
 * from the DB so callers cuma perlu meneruskan runId setelah UPDATE selesai.
 */
export function notifyRunFinishedById(runId: string) {
  if (!NOTIFY_WEBHOOK_URL) return;
  let run: NotifyRunRow | undefined;
  try {
    run = db
      .prepare(
        `SELECT id, project, command_id, status, exit_code, triggered_by,
                created_at, started_at, finished_at
         FROM job_runs WHERE id = ?`,
      )
      .get(runId) as NotifyRunRow | undefined;
  } catch (err) {
    console.warn("[notify] db read failed", err);
    return;
  }
  if (!run) return;
  if (!NOTIFY_ON.includes("all") && !NOTIFY_ON.includes(run.status)) return;

  const type = detectType(NOTIFY_WEBHOOK_URL);
  const payload = buildPayload(run, type);
  // Don't await; never block the request that triggered the finish/cancel.
  void sendWebhook(payload);
}

export async function sendTestNotification() {
  if (!NOTIFY_WEBHOOK_URL) {
    return { ok: false, error: "NOTIFY_WEBHOOK_URL is not set" };
  }
  const now = new Date().toISOString();
  const run: NotifyRunRow = {
    id: "test-" + Math.random().toString(36).slice(2, 8),
    project: "test",
    command_id: "TEST_NOTIFICATION",
    status: "success",
    exit_code: 0,
    triggered_by: "manual-test",
    created_at: now,
    started_at: now,
    finished_at: now,
  };
  const type = detectType(NOTIFY_WEBHOOK_URL);
  return sendWebhook(buildPayload(run, type));
}

export function getNotifyConfig() {
  return {
    enabled: !!NOTIFY_WEBHOOK_URL,
    type: NOTIFY_WEBHOOK_URL ? detectType(NOTIFY_WEBHOOK_URL) : null,
    on: NOTIFY_ON,
    publicUrlSet: !!NOTIFY_PUBLIC_URL,
    timeoutMs: NOTIFY_TIMEOUT_MS,
  };
}
