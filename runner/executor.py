import os
import queue
import subprocess
import threading
import time
from typing import Callable

ALLOWED_COMMANDS = {"COMPOSE_UP", "COMPOSE_DOWN", "COMPOSE_PULL", "COMPOSE_LOGS"}


def _safe_tail_lines(value) -> int:
    try:
        tail = int(value)
    except Exception:
        tail = 200
    return max(1, min(tail, 500))


def build_args(command_id: str, compose_file: str, params: dict):
    if command_id not in ALLOWED_COMMANDS:
        raise ValueError("command not allowed")

    if not compose_file.startswith("/opt/projects/"):
        raise ValueError("compose_file must be under /opt/projects")

    base = ["docker", "compose", "-f", compose_file]

    if command_id == "COMPOSE_UP":
        return base + ["up", "-d", "--remove-orphans"]
    if command_id == "COMPOSE_DOWN":
        return base + ["down"]
    if command_id == "COMPOSE_PULL":
        return base + ["pull"]
    if command_id == "COMPOSE_LOGS":
        tail = _safe_tail_lines(params.get("tailLines", 200))
        return base + ["logs", "--tail", str(tail), "--no-color"]

    raise ValueError("command not allowed")


def run_command(args: list[str], timeout_sec: int, on_log: Callable[[str, str], None], cwd: str | None = None):
    """Run command without shell and stream combined stdout/stderr safely."""
    timeout_sec = max(1, min(int(timeout_sec), 3600))
    output_queue: queue.Queue[str | None] = queue.Queue()

    proc = subprocess.Popen(
        args,
        cwd=cwd if cwd and os.path.isdir(cwd) else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    def reader():
        assert proc.stdout is not None
        for line in proc.stdout:
            output_queue.put(line.rstrip("\n"))
        output_queue.put(None)

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()

    deadline = time.monotonic() + timeout_sec
    reader_done = False

    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            proc.kill()
            on_log("stderr", f"TIMEOUT after {timeout_sec}s")
            return ("timeout", -1)

        try:
            item = output_queue.get(timeout=min(0.5, remaining))
            if item is None:
                reader_done = True
            else:
                on_log("stdout", item)
        except queue.Empty:
            pass

        if reader_done and proc.poll() is not None:
            break

    code = proc.wait(timeout=1)
    return ("success" if code == 0 else "failed", code)
