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

    try:
        args = build_args(command_id, compose_file, params)
    except Exception as exc:
        send_log(run_id, "stderr", f"build error: {exc}")
        return finish(run_id, "failed", -1)

    send_log(run_id, "stdout", f"runner={RUNNER_NAME}")
    send_log(run_id, "stdout", "$ " + " ".join(args))

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
