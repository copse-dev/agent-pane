#!/usr/bin/env python3
"""Own the local engines for one portable Copse session; never adopt another server."""
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

SOURCE = Path(__file__).resolve().parent
RUNTIMES = Path("apps/darwin-arm64/lm-studio-runtimes")
LLAMA = RUNTIMES / "llama.cpp-mac-arm64-apple-metal-advsimd-2.34.0/llama-server"
PYTHON = RUNTIMES / "vendor/_amphibian/app-mlx-generate-mac14-arm64@34/bin/python"


def read_config(path):
    config = json.loads(path.read_text())
    engines = config.get("engines") if isinstance(config, dict) else None
    if not isinstance(engines, list) or not 1 <= len(engines) <= 2:
        raise ValueError("Configure one or two engines in data/local-engines.json")
    kinds, ports = set(), set()
    for engine in engines:
        if not isinstance(engine, dict) or engine.get("kind") not in ("gguf", "mlx"):
            raise ValueError("Engine kind must be gguf or mlx")
        kind, port, context = engine["kind"], engine.get("port"), engine.get("context")
        if kind in kinds or type(port) is not int or not 1024 <= port <= 65535 or port in ports:
            raise ValueError("Each engine needs a unique kind and unprivileged port")
        if type(context) is not int or not 4096 <= context <= 131072:
            raise ValueError("Context must be between 4096 and 131072 tokens")
        model, model_id = engine.get("model"), engine.get("id")
        if not isinstance(model, str) or not model or Path(model).is_absolute() or ".." in Path(model).parts:
            raise ValueError("Model must be a relative path inside models/")
        if not isinstance(model_id, str) or not model_id or len(model_id) > 200:
            raise ValueError("Engine needs a model id of at most 200 characters")
        if kind == "mlx" and model_id != model:
            raise ValueError("The MLX model id must match its relative model directory")
        kinds.add(kind)
        ports.add(port)
    return engines


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as out:
        os.chmod(temporary, 0o600)
        json.dump(value, out, indent=2)
        out.write("\n")
    temporary.replace(path)


def configure_settings(root, engines):
    profile = root / "data/copse/user-data"
    # Electron owns this profile while open. Never race its in-memory settings cache.
    if (profile / "SingletonLock").is_symlink() or (profile / "SingletonLock").exists():
        raise ValueError("Close the portable Copse window before configuring its engines")
    path = profile / "settings.json"
    settings = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(settings, dict) or not isinstance(settings.get("extraProviders", []), list):
        raise ValueError("Invalid existing Copse settings; left unchanged")
    previous = json.dumps(settings, sort_keys=True)
    providers = [p for p in settings.get("extraProviders", [])
                 if not isinstance(p, dict) or p.get("slug") not in ("portable-gguf", "portable-mlx")]
    for engine in engines:
        providers.append({
            "slug": "portable-" + engine["kind"],
            "label": "Drive · " + ("llama.cpp" if engine["kind"] == "gguf" else "MLX"),
            "baseUrl": "http://127.0.0.1:{}/v1".format(engine["port"]),
            "fallbackContextWindow": engine["context"],
            "includeUsage": False,
            "models": [{"id": engine["id"], "contextWindow": engine["context"],
                        "inputPricePerMTok": 0, "outputPricePerMTok": 0}],
        })
    settings["extraProviders"] = providers
    first = engines[0]
    selection = "portable-{}:{}".format(first["kind"], first["id"])
    # Defaults apply only to an unconfigured profile; later user choices survive launches.
    for key in ("model", "localDefaultModel", "smallTasksModel", "subagentModel", "advisorModel"):
        settings.setdefault(key, selection)
    if previous != json.dumps(settings, sort_keys=True):
        if path.exists():
            backup = profile / ("settings.before-local-engines-{}.json".format(time.time_ns()))
            backup.write_bytes(path.read_bytes())
            backup.chmod(0o600)
        atomic_json(path, settings)


def engine_command(root, engine):
    model = (root / "models" / engine["model"]).resolve()
    if not model.is_relative_to((root / "models").resolve()) or not model.exists():
        raise ValueError("Model missing or outside drive models/: " + str(model))
    if engine["kind"] == "gguf":
        command = [str(root / LLAMA), "--model", str(model), "--alias", engine["id"],
                   "--ctx-size", str(engine["context"]), "--parallel", "1", "--jinja",
                   "--no-warmup", "--host", "127.0.0.1", "--port", str(engine["port"])]
    else:
        command = [str(root / PYTHON), "-I", "-m", "mlx_lm", "server",
                   "--model", engine["model"], "--host", "127.0.0.1", "--port", str(engine["port"]),
                   "--decode-concurrency", "1", "--prompt-concurrency", "1",
                   "--prompt-cache-size", "1", "--prompt-cache-bytes", "1073741824",
                   "--prefill-step-size", "512", "--max-tokens", "4096",
                   "--chat-template-args", '{"enable_thinking":false}']
    if not os.access(command[0], os.X_OK):
        raise ValueError("Install the drive runtimes first: make portable-local-ai-runtimes-offline")
    return command


def wait_ready(process, engine, log):
    deadline = time.monotonic() + 240
    url = "http://127.0.0.1:{}/v1/chat/completions".format(engine["port"])
    body = json.dumps({"model": engine["id"], "messages": [{"role": "user", "content": "Say ready."}],
                       "max_tokens": 8, "temperature": 0, "stream": False}).encode()
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("{} exited; see {}".format(engine["kind"], log))
        try:
            request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.load(response)
            if process.poll() is not None:
                raise RuntimeError("{} exited during readiness check; see {}".format(engine["kind"], log))
            if not result.get("choices"):
                raise RuntimeError("Engine returned no completion: " + str(log))
            print("{} ready: {} ({})".format(engine["kind"], engine["id"], url), flush=True)
            return
        except urllib.error.HTTPError as error:
            if error.code != 503:
                raise RuntimeError("Engine HTTP {}: {}; see {}".format(error.code, error.read().decode()[:600], log)) from error
        except (urllib.error.URLError, TimeoutError):
            pass
        time.sleep(1)
    raise RuntimeError("Engine startup timed out; see " + str(log))


def stop(children):
    # Popen objects refer only to children created during this invocation, never saved PIDs.
    for child in reversed(children):
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for child in reversed(children):
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            child.wait()


def main():
    root = Path(sys.argv[1]).resolve()
    action = sys.argv[2]
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True)
    config = data / "local-engines.json"
    with (data / "local-engines.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Portable engines/Copse are already running; use the open window") from error
        config_source = SOURCE / "local-engines.json" if action == "enable" and not config.exists() else config
        engines = read_config(config_source)
        commands = [engine_command(root, engine) for engine in engines]
        if action == "enable":
            configure_settings(root, engines)
            if not config.exists():
                atomic_json(config, {"engines": engines})
            print("Enabled drive engines. Launch Copse.command or make portable-run will start them.")
            return
        if action not in ("run", "serve"):
            raise ValueError("Action must be enable, run or serve")
        if os.environ.get("COPSE_PORTABLE_OFFLINE") == "1":
            raise ValueError("The strict --offline sandbox blocks loopback too. Use normal run for local inference.")
        for engine in engines:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", engine["port"]))
        configure_settings(root, engines)
        logs = data / "local-engine-logs"
        logs.mkdir(exist_ok=True)
        environment = dict(os.environ, HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                           HF_HOME=str(root / "cache/huggingface"), HF_HUB_DISABLE_TELEMETRY="1")
        children = []
        def interrupted(signum, frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, interrupted)
        signal.signal(signal.SIGINT, interrupted)
        try:
            for engine, command in zip(engines, commands):
                log = logs / (engine["kind"] + ".log")
                with log.open("a") as output:
                    child = subprocess.Popen(command, cwd=root / "models", env=environment,
                                             stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                children.append(child)
                wait_ready(child, engine, log)
            if action == "serve":
                print("Engines ready. Ctrl-C stops this session's engines.", flush=True)
                while all(child.poll() is None for child in children):
                    time.sleep(1)
                raise RuntimeError("An engine stopped; see " + str(logs))
            # Keep the application in our session. The engines live exactly as long as this launch.
            app = subprocess.Popen(["pnpm", "start"], cwd=SOURCE.parent.parent)
            try:
                return app.wait()
            except KeyboardInterrupt:
                app.terminate()
                app.wait()
                raise
        finally:
            stop(children)


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except KeyboardInterrupt:
        sys.exit(130)
    except (ValueError, RuntimeError, OSError) as error:
        print("Portable local engines: " + str(error), file=sys.stderr)
        sys.exit(1)
