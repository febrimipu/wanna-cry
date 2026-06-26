import os
import time
import yaml
import requests

from executor import ALLOWED_COMMANDS, build_args, run_command

API = os.environ["API_BASE_URL"].rstrip("/")
TOKEN = os.environ["RUNNER_TOKEN"]
RUNNER_NAME = os.environ.get("RUNNER_NAME", "runner-1")
POLL = int(os.environ.get("POLL_INTERVAL_SEC", "2"))
HEADERS = {"Authorization": f"Bearer {TOKEN}"}

with open("/app/config.yml") as f:
    CONFIG = yaml.safe_load(f) or {}
PROJECTS = CONFIG.get("projects", {})


def post(path, payload, timeout=10):
    return requests.post(f"{API}{path}", json=payload, headers=HEADERS, timeout=timeout)


def get(path, timeout=10):
    return requests.get(f"{API}{path}", headers=HEADERS, timeout=timeout)


def is_canceled(run_id: str) -> bool:
    """Best-effort cooperative cancellation.

    Control-plane exposes GET /runner/run/:id (runner-auth protected).
    If status is 'canceled', stop as early as possible.
    """
    try:
        r = get(f"/runner/run/{run_id}", timeout=5)
        if r.status_code != 200:
            return False
        data = r.json() or {}
        return data.get("status") == "canceled"
    except Exception:
        return False


def send_log(run_id, stream, chunk):
    if chunk is None:
        return
    try:
        post("/runner/log", {"runId": run_id, "stream": stream, "chunk": str(chunk)})
    except Exception as exc:
        print("log send failed:", exc, flush=True)


def finish(run_id, status, exit_code):
    try:
        post("/runner/finish", {"runId": run_id, "status": status, "exitCode": exit_code})
    except Exception as exc:
        print("finish failed:", exc, flush=True)


def handle(job):
    run_id = job["runId"]
    project = job["project"]
    command_id = job["commandId"]
    params = job.get("params", {}) or {}
    timeout_sec = int(job.get("timeoutSec", 600))

    if project not in PROJECTS:
        send_log(run_id, "stderr", f"project '{project}' tidak ada di allowlist")
        return finish(run_id, "failed", -1)

    if command_id not in ALLOWED_COMMANDS:
        send_log(run_id, "stderr", f"command '{command_id}' tidak diizinkan")
        return finish(run_id, "failed", -1)

    project_config = PROJECTS[project]
    compose_file = project_config.get("compose_file")
    workdir = project_config.get("workdir")
    repo_dir = project_config.get("repo_dir")

    def log(stream, msg):
        send_log(run_id, stream, msg)

    send_log(run_id, "stdout", f"runner={RUNNER_NAME}")

    if is_canceled(run_id):
        send_log(run_id, "stderr", "Canceled before start")
        return finish(run_id, "canceled", -1)

    # DEPLOY pipeline: git pull + compose pull + up
    if command_id == "DEPLOY":
        if not repo_dir or not str(repo_dir).startswith("/opt/projects/"):
            log("stderr", "repo_dir missing or not under /opt/projects")
            return finish(run_id, "failed", -1)

        # Step 1: git pull
        git_args = ["git", "-C", repo_dir, "pull", "--ff-only"]
        log("stdout", "$ " + " ".join(git_args))
        status, code = run_command(git_args, min(timeout_sec, 900), lambda s, c: log(s, c), cwd=None)
        if status != "success":
            return finish(run_id, status, code)

        if is_canceled(run_id):
            log("stderr", "Canceled after git pull")
            return finish(run_id, "canceled", -1)

        # Step 2: compose pull
        pull_args = ["docker", "compose", "-f", compose_file, "pull"]
        log("stdout", "$ " + " ".join(pull_args))
        status, code = run_command(pull_args, min(timeout_sec, 1800), lambda s, c: log(s, c), cwd=workdir)
        if status != "success":
            return finish(run_id, status, code)

        if is_canceled(run_id):
            log("stderr", "Canceled after compose pull")
            return finish(run_id, "canceled", -1)

        # Step 3: compose up
        up_args = ["docker", "compose", "-f", compose_file, "up", "-d", "--remove-orphans"]
        log("stdout", "$ " + " ".join(up_args))
        status, code = run_command(up_args, min(timeout_sec, 1800), lambda s, c: log(s, c), cwd=workdir)
        return finish(run_id, status, code)

    # Default single command
    try:
        args = build_args(command_id, compose_file, params)
    except Exception as exc:
        send_log(run_id, "stderr", f"build error: {exc}")
        return finish(run_id, "failed", -1)

    send_log(run_id, "stdout", "$ " + " ".join(args))
    if is_canceled(run_id):
        send_log(run_id, "stderr", "Canceled before execution")
        return finish(run_id, "canceled", -1)
    status, code = run_command(args, timeout_sec, lambda s, c: send_log(run_id, s, c), cwd=workdir)
    finish(run_id, status, code)


def main():
    print(f"{RUNNER_NAME} started, polling {API}", flush=True)
    while True:
        try:
            response = requests.post(f"{API}/runner/claim", headers=HEADERS, timeout=15)
            if response.status_code == 200:
                handle(response.json())
                continue
            if response.status_code != 204:
                print("claim status", response.status_code, response.text[:200], flush=True)
        except Exception as exc:
            print("claim error:", exc, flush=True)

        time.sleep(POLL)


if __name__ == "__main__":
    main()
