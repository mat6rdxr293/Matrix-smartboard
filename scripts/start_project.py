#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
RUNTIME = ROOT / ".matrix-runtime"
LOG_DIR = RUNTIME / "logs"
STATE_DIR = RUNTIME / "state"
ENV_FILE = BACKEND / ".env"
ENV_EXAMPLE = BACKEND / ".env.example"

MIN_PYTHON = (3, 11)
MIN_NODE_MAJOR = 18
BACKEND_IMPORTS = (
    "fastapi",
    "uvicorn",
    "pydantic_settings",
    "pymupdf",
    "pytesseract",
    "openai",
    "pptx",
    "PIL",
    "httpx",
    "cryptography",
    "sympy",
    "pint",
    "psutil",
    "zeroconf",
)


class LauncherError(RuntimeError):
    pass


@dataclass
class ManagedProcess:
    name: str
    process: subprocess.Popen
    log_handle: object
    log_path: Path


managed: list[ManagedProcess] = []


def info(message: str) -> None:
    print(f"[Matrix] {message}", flush=True)


def ok(message: str) -> None:
    print(f"[  OK  ] {message}", flush=True)


def warn(message: str) -> None:
    print(f"[ WARN ] {message}", flush=True)


def fail(message: str) -> None:
    print(f"[ERROR ] {message}", file=sys.stderr, flush=True)


def platform_name() -> str:
    if os.name == "nt":
        return "Windows"
    if sys.platform == "darwin":
        return "macOS"
    return "Linux"


def command_path(name: str) -> str | None:
    names = [name]
    if os.name == "nt" and not Path(name).suffix:
        names = [f"{name}.exe", f"{name}.cmd", f"{name}.bat", name]
    for candidate in names:
        value = shutil.which(candidate)
        if value:
            return value
    return None


def run_checked(args: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    shown = " ".join(str(x) for x in args)
    info(f"$ {shown}")
    result = subprocess.run(args, cwd=cwd, env=env)
    if result.returncode != 0:
        raise LauncherError(f"Command failed ({result.returncode}): {shown}")


def run_capture(args: list[str], *, cwd: Path | None = None) -> str:
    try:
        result = subprocess.run(
            args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=20,
        )
    except Exception:
        return ""
    return (result.stdout or "").strip() if result.returncode == 0 else ""


def verify_project() -> None:
    required = (
        BACKEND / "requirements.txt",
        BACKEND / "app" / "main.py",
        FRONTEND / "package.json",
        FRONTEND / "vite.config.ts",
    )
    missing = [str(path.relative_to(ROOT)) for path in required if not path.exists()]
    if missing:
        raise LauncherError(
            "Project checkout is incomplete. Missing: " + ", ".join(missing)
        )
    ok(f"Project found: {ROOT}")


def verify_python() -> None:
    if sys.version_info < MIN_PYTHON:
        raise LauncherError(
            f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ is required; "
            f"current is {sys.version_info.major}.{sys.version_info.minor}."
        )
    ok(f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}")


def verify_node() -> tuple[str, str]:
    node = command_path("node")
    npm = command_path("npm")
    if not node or not npm:
        raise LauncherError(
            "Node.js + npm are required. Install Node.js LTS and run this launcher again."
        )
    version = run_capture([node, "--version"]).lstrip("v")
    try:
        major = int(version.split(".", 1)[0])
    except Exception as exc:
        raise LauncherError(f"Could not determine Node.js version: {version}") from exc
    if major < MIN_NODE_MAJOR:
        raise LauncherError(
            f"Node.js {MIN_NODE_MAJOR}+ is required; current is {version}."
        )
    ok(f"Node.js {version}, npm {run_capture([npm, '--version'])}")
    return node, npm


def sha256_files(paths: Iterable[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def venv_python() -> Path:
    if os.name == "nt":
        return ROOT / ".venv" / "Scripts" / "python.exe"
    return ROOT / ".venv" / "bin" / "python"


def ensure_backend_dependencies(skip_install: bool) -> Path:
    python = venv_python()
    requirements = BACKEND / "requirements.txt"
    marker = STATE_DIR / "backend-requirements.sha256"
    wanted_hash = sha256_files([requirements])

    venv_ok = python.exists() and bool(run_capture([str(python), "-c", "import sys; print(sys.executable)"]))
    if not venv_ok:
        if skip_install:
            raise LauncherError(".venv is missing or broken and --skip-install was used.")
        if (ROOT / ".venv").exists():
            warn("Broken .venv detected; recreating it.")
            shutil.rmtree(ROOT / ".venv", ignore_errors=True)
        info("Creating Python virtual environment .venv...")
        run_checked([sys.executable, "-m", "venv", str(ROOT / ".venv")])

    import_probe = "; ".join(f"import {name}" for name in BACKEND_IMPORTS)
    imports_ok = bool(run_capture([str(python), "-c", import_probe + "; print('ok')"]))
    marker_ok = marker.exists() and marker.read_text(encoding="utf-8").strip() == wanted_hash

    if not (imports_ok and marker_ok):
        if skip_install:
            raise LauncherError("Backend dependencies are missing/outdated and --skip-install was used.")
        info("Installing/updating backend dependencies...")
        run_checked([str(python), "-m", "pip", "install", "-r", str(requirements)])
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(wanted_hash + "\n", encoding="utf-8")
    else:
        ok("Backend dependencies are current.")

    if not bool(run_capture([str(python), "-c", import_probe + "; print('ok')"])):
        raise LauncherError("Backend dependency verification failed after installation.")
    return python


def ensure_frontend_dependencies(npm: str, skip_install: bool) -> None:
    package_lock = FRONTEND / "package-lock.json"
    package_json = FRONTEND / "package.json"
    inputs = [package_json] + ([package_lock] if package_lock.exists() else [])
    wanted_hash = sha256_files(inputs)
    marker = STATE_DIR / "frontend-dependencies.sha256"

    node_modules = FRONTEND / "node_modules"
    marker_ok = marker.exists() and marker.read_text(encoding="utf-8").strip() == wanted_hash
    npm_ok = node_modules.exists() and bool(run_capture([npm, "ls", "--depth=0"], cwd=FRONTEND))

    if not (marker_ok and npm_ok):
        if skip_install:
            raise LauncherError("Frontend dependencies are missing/outdated and --skip-install was used.")
        info("Installing/updating frontend dependencies...")
        command = [npm, "ci"] if package_lock.exists() else [npm, "install"]
        run_checked(command, cwd=FRONTEND)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(wanted_hash + "\n", encoding="utf-8")
    else:
        ok("Frontend dependencies are current.")


def ensure_env() -> dict[str, str]:
    if not ENV_FILE.exists():
        if not ENV_EXAMPLE.exists():
            raise LauncherError("backend/.env and backend/.env.example are both missing.")
        shutil.copy2(ENV_EXAMPLE, ENV_FILE)
        info("Created backend/.env from backend/.env.example")

    values: dict[str, str] = {}
    for raw in ENV_FILE.read_text(encoding="utf-8-sig", errors="ignore").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip().upper()] = value.strip().strip("'\"")
    ok("backend/.env is present.")
    return values


def http_json(url: str, timeout: float = 2.0) -> dict | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Matrix-Smartboard-Launcher"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            if response.status < 200 or response.status >= 300:
                return None
            payload = response.read()
        value = json.loads(payload.decode("utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:
        return None


def http_ok(url: str, timeout: float = 2.0) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Matrix-Smartboard-Launcher"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return 200 <= response.status < 400
    except Exception:
        return False


def wait_until(predicate, timeout: float, label: str) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            ok(label)
            return
        time.sleep(0.4)
    raise LauncherError(f"Timed out waiting for {label}.")


def start_process(
    name: str,
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
) -> ManagedProcess:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{name}.log"
    log_handle = log_path.open("w", encoding="utf-8", buffering=1)
    kwargs: dict = {
        "cwd": cwd,
        "env": env,
        "stdout": log_handle,
        "stderr": subprocess.STDOUT,
        "text": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(args, **kwargs)
    item = ManagedProcess(name, process, log_handle, log_path)
    managed.append(item)
    info(f"Started {name} (PID {process.pid}); log: {log_path.relative_to(ROOT)}")
    return item


def stop_process(item: ManagedProcess) -> None:
    if item.process.poll() is not None:
        try:
            item.log_handle.close()
        except Exception:
            pass
        return
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(item.process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
            )
        else:
            os.killpg(item.process.pid, signal.SIGTERM)
            try:
                item.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(item.process.pid, signal.SIGKILL)
    except Exception:
        try:
            item.process.terminate()
        except Exception:
            pass
    try:
        item.log_handle.close()
    except Exception:
        pass


def tail(path: Path, lines: int = 24) -> str:
    try:
        data = path.read_text(encoding="utf-8", errors="replace").splitlines()
        return "\n".join(data[-lines:])
    except Exception:
        return ""


def cleanup() -> None:
    for item in reversed(managed):
        stop_process(item)


def local_base(url: str | None) -> tuple[str, int] | None:
    if not url:
        return None
    try:
        parsed = urllib.parse.urlparse(url)
        host = (parsed.hostname or "").lower()
        if host not in {"127.0.0.1", "localhost", "::1"}:
            return None
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return host, port
    except Exception:
        return None


def ollama_ready() -> bool:
    return http_json("http://127.0.0.1:11434/api/tags") is not None


def ollama_models() -> set[str]:
    payload = http_json("http://127.0.0.1:11434/api/tags") or {}
    result: set[str] = set()
    for item in payload.get("models", []):
        if isinstance(item, dict):
            for key in ("name", "model"):
                value = item.get(key)
                if isinstance(value, str) and value:
                    result.add(value)
    return result


def model_present(configured: str, available: set[str]) -> bool:
    if configured in available:
        return True
    if ":" not in configured and configured + ":latest" in available:
        return True
    return any(item.split("@", 1)[0] == configured for item in available)


def ensure_ollama(
    env_values: dict[str, str],
    *,
    skip_model_pull: bool,
) -> None:
    ollama = command_path("ollama")
    if not ollama:
        raise LauncherError(
            "backend/.env points to local Ollama, but Ollama is not installed or not in PATH. "
            "Install Ollama, then run the launcher again."
        )

    if not ollama_ready():
        start_process("ollama", [ollama, "serve"], cwd=ROOT, env=os.environ.copy())
        wait_until(ollama_ready, 30, "Ollama API is ready")
    else:
        ok("Ollama is already running.")

    wanted = []
    for key in ("AI_MODEL", "OCR_MODEL"):
        value = env_values.get(key, "").strip()
        if value and value not in wanted:
            wanted.append(value)

    available = ollama_models()
    missing = [model for model in wanted if not model_present(model, available)]
    if missing and skip_model_pull:
        raise LauncherError(
            "Missing Ollama models: " + ", ".join(missing) + ". Remove --skip-model-pull or pull them manually."
        )
    for model in missing:
        info(f"Downloading missing Ollama model: {model}")
        run_checked([ollama, "pull", model])
    if wanted:
        ok("Ollama models: " + ", ".join(wanted))


def llama_server_binary() -> Path | None:
    base = ROOT / "ml" / "llama.cpp" / "build" / "bin"
    candidates = [base / "llama-server"]
    if os.name == "nt":
        candidates.insert(0, base / "llama-server.exe")
        candidates.append(ROOT / "ml" / "llama.cpp" / "build" / "bin" / "Release" / "llama-server.exe")
    return next((path for path in candidates if path.exists()), None)


def default_llama_model() -> Path | None:
    override = os.environ.get("MATRIX_LLAMA_MODEL")
    if override:
        path = Path(override).expanduser()
        if not path.is_absolute():
            path = ROOT / path
        return path if path.exists() else None
    models_dir = ROOT / "ml" / "models"
    preferred = models_dir / "Qwen3.5-4B-Q4_K_M.gguf"
    if preferred.exists():
        return preferred
    matches = sorted(models_dir.glob("*.gguf")) if models_dir.exists() else []
    return matches[0] if matches else None


def ensure_llama_server(base_url: str, model_alias: str) -> None:
    endpoint = base_url.rstrip("/") + "/models"
    if http_ok(endpoint):
        ok(f"llama-server is already running at {base_url}")
        return
    binary = llama_server_binary()
    model = default_llama_model()
    if not binary or not model:
        raise LauncherError(
            f"backend/.env points to local llama-server ({base_url}), but the bundled llama-server/model "
            "was not found. Build ml/llama.cpp and place a GGUF in ml/models, or change AI_BASE_URL."
        )

    parsed = urllib.parse.urlparse(base_url)
    host = parsed.hostname or "127.0.0.1"
    port = parsed.port or 8080
    threads = os.environ.get("MATRIX_LLAMA_THREADS") or str(max(1, min(4, os.cpu_count() or 4)))
    ctx = os.environ.get("MATRIX_LLAMA_CTX", "8192")
    args = [
        str(binary),
        "-m", str(model),
        "--alias", model_alias or model.stem.lower().replace("_", "-"),
        "--host", host,
        "--port", str(port),
        "-t", threads,
        "-tb", threads,
        "-c", ctx,
        "-np", "1",
        "-lm", "none",
        "--jinja",
        "--chat-template-kwargs", '{"enable_thinking": false}',
    ]
    start_process("llama-server", args, cwd=ROOT / "ml")
    wait_until(lambda: http_ok(endpoint), 60, f"llama-server at {base_url}")


def ensure_ai_services(
    env_values: dict[str, str],
    *,
    skip_ai: bool,
    skip_model_pull: bool,
) -> None:
    if skip_ai:
        warn("AI/OCR service checks were skipped.")
        return

    urls = {
        env_values.get("AI_BASE_URL", "").strip(),
        env_values.get("OCR_BASE_URL", "").strip(),
    }
    urls.discard("")
    local_urls = [url for url in urls if local_base(url)]
    if not local_urls:
        ok("No local AI/OCR service is configured.")
        return

    needs_ollama = any((local_base(url) or ("", 0))[1] == 11434 for url in local_urls)
    if needs_ollama:
        ensure_ollama(env_values, skip_model_pull=skip_model_pull)

    for url in local_urls:
        host_port = local_base(url)
        if not host_port:
            continue
        _, port = host_port
        if port == 11434:
            continue
        if port == 8080:
            ensure_llama_server(url, env_values.get("AI_MODEL", ""))
            continue
        if not http_ok(url.rstrip("/") + "/models"):
            raise LauncherError(
                f"Configured local AI/OCR endpoint is not reachable: {url}. "
                "The launcher auto-starts Ollama (:11434) and bundled llama-server (:8080)."
            )
        ok(f"Local AI/OCR endpoint is reachable: {url}")


def backend_health(port: int) -> dict | None:
    payload = http_json(f"http://127.0.0.1:{port}/api/status")
    if payload and payload.get("product") == "matrix-smartboard":
        return payload
    return None


def port_is_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False


def ensure_backend(python: Path, port: int, frontend_port: int) -> ManagedProcess | None:
    existing = backend_health(port)
    if existing:
        ok(f"Backend already running at http://127.0.0.1:{port}")
        return None
    if port_is_open(port):
        raise LauncherError(f"Port {port} is already used by another process.")

    env = os.environ.copy()
    env["PRACTICE_DEV_FRONTEND_URL"] = f"http://127.0.0.1:{frontend_port}"
    process = start_process(
        "backend",
        [
            str(python),
            "-m",
            "uvicorn",
            "app.main:app",
            "--reload",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
        ],
        cwd=BACKEND,
        env=env,
    )
    try:
        wait_until(lambda: backend_health(port) is not None, 30, "Backend API is ready")
    except Exception:
        log = tail(process.log_path)
        if log:
            print("\n--- backend.log ---\n" + log, file=sys.stderr)
        raise
    return process


def ensure_frontend(npm: str, port: int) -> ManagedProcess | None:
    url = f"http://127.0.0.1:{port}/"
    if http_ok(url):
        ok(f"Frontend already running at {url}")
        return None
    if port_is_open(port):
        raise LauncherError(f"Port {port} is already used by another process.")

    process = start_process(
        "frontend",
        [npm, "run", "dev", "--", "--host", "127.0.0.1", "--port", str(port)],
        cwd=FRONTEND,
        env=os.environ.copy(),
    )
    try:
        wait_until(lambda: http_ok(url), 30, "Frontend is ready")
    except Exception:
        log = tail(process.log_path)
        if log:
            print("\n--- frontend.log ---\n" + log, file=sys.stderr)
        raise
    return process


def status_summary(backend_port: int, frontend_port: int, env_values: dict[str, str]) -> None:
    print()
    print("=" * 68)
    print(" Matrix Smartboard")
    print("=" * 68)
    print(f" Frontend : http://127.0.0.1:{frontend_port}")
    print(f" Backend  : http://127.0.0.1:{backend_port}")
    ai_url = env_values.get("AI_BASE_URL", "").strip()
    ocr_url = env_values.get("OCR_BASE_URL", "").strip()
    print(f" AI       : {ai_url or 'not configured'}")
    print(f" OCR      : {ocr_url or 'not configured'}")
    print(f" Logs     : {LOG_DIR.relative_to(ROOT)}")
    print("=" * 68)
    print(" Press Ctrl+C to stop services started by this launcher.")
    print()


def monitor() -> None:
    if not managed:
        info("All services were already running; nothing new was started.")
        return
    try:
        while True:
            for item in managed:
                code = item.process.poll()
                if code is not None:
                    log = tail(item.log_path)
                    if log:
                        print(f"\n--- {item.name}.log ---\n{log}", file=sys.stderr)
                    raise LauncherError(f"{item.name} stopped unexpectedly with exit code {code}.")
            time.sleep(0.8)
    except KeyboardInterrupt:
        info("Stopping Matrix Smartboard...")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Matrix Smartboard cross-platform launcher")
    parser.add_argument("--check-only", action="store_true", help="verify/install dependencies, but do not start services")
    parser.add_argument("--skip-install", action="store_true", help="do not install missing project dependencies")
    parser.add_argument("--skip-ai", action="store_true", help="do not check/start configured local AI/OCR services")
    parser.add_argument("--skip-model-pull", action="store_true", help="do not download missing Ollama models")
    parser.add_argument("--backend-port", type=int, default=int(os.environ.get("MATRIX_BACKEND_PORT", "8001")))
    parser.add_argument("--frontend-port", type=int, default=int(os.environ.get("MATRIX_FRONTEND_PORT", "5174")))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    RUNTIME.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)

    info(f"Platform: {platform_name()}")
    verify_project()
    verify_python()
    _, npm = verify_node()
    python = ensure_backend_dependencies(args.skip_install)
    ensure_frontend_dependencies(npm, args.skip_install)
    env_values = ensure_env()
    ensure_ai_services(
        env_values,
        skip_ai=args.skip_ai,
        skip_model_pull=args.skip_model_pull,
    )

    if args.check_only:
        ok("Project and configured dependencies are ready.")
        return 0

    ensure_backend(python, args.backend_port, args.frontend_port)
    ensure_frontend(npm, args.frontend_port)
    status_summary(args.backend_port, args.frontend_port, env_values)
    monitor()
    return 0


if __name__ == "__main__":
    try:
        exit_code = main()
    except LauncherError as exc:
        fail(str(exc))
        exit_code = 2
    except KeyboardInterrupt:
        exit_code = 130
    finally:
        cleanup()
    raise SystemExit(exit_code)
