#!/usr/bin/env python3
"""Own the local engines for one portable Copse session; never adopt another server."""
import fcntl
import http.client
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
# runtime-setup.sh records the path at which it regenerated the runtimes' absolute paths.
RUNTIME_LOCATION = ".installed-path"
PORTABLE_SLUGS = ("portable-gguf", "portable-mlx")
ROUTED_KEYS = ("model", "localDefaultModel", "smallTasksModel", "subagentModel", "advisorModel",
               "reviewModel")
STOP_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
# Runs in its own session so closing the terminal cannot kill it first. When the supervisor
# dies by any means, including SIGKILL, its pipe closes and this stops the engine's group.
WATCHDOG = """
import os, signal, sys, time
sys.stdin.buffer.read()
group = int(sys.argv[1])
for sig in (signal.SIGTERM, signal.SIGKILL):
    try:
        os.killpg(group, sig)
    except ProcessLookupError:
        sys.exit(0)
    for _ in range(150):
        time.sleep(0.1)
        try:
            os.killpg(group, 0)
        except ProcessLookupError:
            sys.exit(0)
"""


def runtime_directory(prefix):
    """The pinned runtime directory, read from runtimes.tsv so the two cannot drift."""
    with (SOURCE / "runtimes.tsv").open() as manifest:
        matches = [line.split("\t", 1)[0] for line in manifest if line.startswith(prefix)]
    if len(matches) != 1:
        raise ValueError("runtimes.tsv must pin exactly one {} runtime".format(prefix))
    return RUNTIMES / matches[0]


LLAMA = runtime_directory("llama.cpp-") / "llama-server"
PYTHON = runtime_directory("vendor/_amphibian/app-mlx-generate-") / "bin/python"


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


def check_profile_closed(profile):
    """Electron owns the profile while open; never race its in-memory settings cache.

    Chromium's SingletonLock is a symlink to `<host>-<pid>`. A crash, power loss or pulled
    drive leaves it behind, so a lock whose process is gone on this Mac is stale.
    """
    lock = profile / "SingletonLock"
    try:
        target = os.readlink(lock)
    except FileNotFoundError:
        return
    except OSError as error:
        raise ValueError("Close the portable Copse window before configuring its engines") from error
    host, _, pid = target.rpartition("-")
    if host != socket.gethostname() or not pid.isdigit():
        raise ValueError("The portable Copse profile is locked by {}. If Copse is not running there, "
                         "delete {}".format(target, lock))
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return
    except PermissionError:
        pass
    raise ValueError("Close the portable Copse window before configuring its engines")


def is_portable_selection(value):
    return isinstance(value, str) and value.startswith(tuple(slug + ":" for slug in PORTABLE_SLUGS))


def load_settings(path):
    settings = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(settings, dict) or not isinstance(settings.get("extraProviders", []), list):
        raise ValueError("Invalid existing Copse settings; left unchanged")
    return settings


def save_settings(path, settings, previous):
    if previous == json.dumps(settings, sort_keys=True):
        return
    if path.exists():
        backup = path.parent / ("settings.before-local-engines-{}.json".format(time.time_ns()))
        backup.write_bytes(path.read_bytes())
        backup.chmod(0o600)
    atomic_json(path, settings)


def configure_settings(root, engines):
    profile = root / "data/copse/user-data"
    check_profile_closed(profile)
    path = profile / "settings.json"
    settings = load_settings(path)
    previous = json.dumps(settings, sort_keys=True)
    providers = [p for p in settings.get("extraProviders", [])
                 if not isinstance(p, dict) or p.get("slug") not in PORTABLE_SLUGS]
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
    # A profile without a chat model is unconfigured: route every role, including the review
    # that otherwise defaults to LM Studio, to the first engine. Once a chat model is chosen,
    # the user's routing (including roles left on automatic) is never changed.
    if not settings.get("model"):
        first = engines[0]
        selection = "portable-{}:{}".format(first["kind"], first["id"])
        for key in ROUTED_KEYS:
            settings.setdefault(key, selection)
    save_settings(path, settings, previous)


def remove_settings(root):
    """Undo configure_settings: drop drive providers and every selection that names them."""
    profile = root / "data/copse/user-data"
    check_profile_closed(profile)
    path = profile / "settings.json"
    if not path.exists():
        return
    settings = load_settings(path)
    previous = json.dumps(settings, sort_keys=True)
    if "extraProviders" in settings:
        settings["extraProviders"] = [p for p in settings["extraProviders"]
                                      if not isinstance(p, dict) or p.get("slug") not in PORTABLE_SLUGS]
    for key in ROUTED_KEYS:
        if is_portable_selection(settings.get(key)):
            del settings[key]
    role_models = settings.get("roleModels")
    if isinstance(role_models, dict):
        for role in [role for role, value in role_models.items() if is_portable_selection(value)]:
            del role_models[role]
    save_settings(path, settings, previous)


def check_runtime_location(root):
    runtimes = (root / RUNTIMES).resolve()
    try:
        recorded = (runtimes / RUNTIME_LOCATION).read_text().strip()
    except FileNotFoundError:
        recorded = ""
    if recorded != str(runtimes):
        raise ValueError("The drive runtimes were prepared at {} and must be repaired for this mount "
                         "path: make portable-local-ai-runtimes-offline".format(recorded or "an unknown path"))


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
    if not (root / RUNTIMES).is_dir():
        raise ValueError("Install the drive runtimes first: make portable-local-ai-runtimes")
    check_runtime_location(root)
    if not os.access(command[0], os.X_OK):
        raise ValueError("Incomplete drive runtime {}: make portable-local-ai-runtimes-offline".format(command[0]))
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
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError,
                http.client.HTTPException):
            # Not listening yet, or dropped the connection while loading. On macOS's Python 3.9,
            # socket.timeout is not yet an alias of TimeoutError.
            pass
        time.sleep(1)
    raise RuntimeError("Engine startup timed out; see " + str(log))


def start_watchdog(child, guard):
    return subprocess.Popen([sys.executable, "-I", "-c", WATCHDOG, str(child.pid)], stdin=guard,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True)


def stop(children, watchdogs=()):
    # A second signal must not abandon engines halfway through shutdown. Restore the handlers
    # afterwards: ignored signals would otherwise be inherited by any later child.
    previous = {signum: signal.signal(signum, signal.SIG_IGN) for signum in STOP_SIGNALS}
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
    # Engines are reaped; retire their watchdogs before the pipe closes at exit.
    for watchdog in watchdogs:
        watchdog.kill()
        watchdog.wait()
    for signum, handler in previous.items():
        signal.signal(signum, handler)


def main():
    root = Path(sys.argv[1]).resolve()
    action = sys.argv[2]
    data = root / "data"
    data.mkdir(parents=True, exist_ok=True)
    config = data / "local-engines.json"
    disabled = data / "local-engines.disabled.json"
    defaults = SOURCE / "local-engines.json"
    if action not in ("enable", "disable", "run", "serve"):
        raise ValueError("Action must be enable, disable, run or serve")
    with (data / "local-engines.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Portable engines/Copse are already running; use the open window") from error
        if action == "disable":
            remove_settings(root)
            if config.exists():
                config.replace(disabled)
            print("Disabled drive engines. Plain portable launches no longer start them.")
            return
        config_source = config
        if action == "enable" and not config.exists():
            config_source = disabled if disabled.exists() else defaults
        engines = read_config(config_source)
        if config_source == defaults:
            # The default pair spans the starter models and the optional library; start with
            # whichever is installed rather than requiring both.
            missing = [e for e in engines if not (root / "models" / e["model"]).exists()]
            engines = [e for e in engines if e not in missing]
            if not engines:
                raise ValueError("Model missing for every default engine. Install one first: "
                                 "make portable-local-ai-setup or make portable-local-ai-library")
            for engine in missing:
                print("Skipping the {} engine: {} is not installed (make portable-local-ai-library). "
                      "Add it later in data/local-engines.json.".format(engine["kind"], engine["model"]))
        commands = [engine_command(root, engine) for engine in engines]
        if action == "enable":
            configure_settings(root, engines)
            if not config.exists():
                atomic_json(config, {"engines": engines})
            if disabled.exists():
                disabled.unlink()
            print("Enabled drive engines. Launch Copse.command or make portable-run will start them.")
            return
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
        children, watchdogs = [], []
        def interrupted(signum, frame):
            raise KeyboardInterrupt
        # SIGHUP arrives when the Terminal window of a Finder launch closes.
        for signum in STOP_SIGNALS:
            signal.signal(signum, interrupted)
        # Only this process holds the write end; children never inherit it (close_fds).
        guard, guard_write = os.pipe()
        try:
            for engine, command in zip(engines, commands):
                log = logs / (engine["kind"] + ".log")
                with log.open("a") as output:
                    child = subprocess.Popen(command, cwd=root / "models", env=environment,
                                             stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                children.append(child)
                watchdogs.append(start_watchdog(child, guard))
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
            stop(children, watchdogs)


if __name__ == "__main__":
    try:
        sys.exit(main() or 0)
    except KeyboardInterrupt:
        sys.exit(130)
    except (ValueError, RuntimeError, OSError) as error:
        print("Portable local engines: " + str(error), file=sys.stderr)
        sys.exit(1)
