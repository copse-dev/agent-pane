"""Regression coverage for portable process ownership and profile/config boundaries."""
import copy
import http.client
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("local-engines.py")
spec = importlib.util.spec_from_file_location("local_engines", SCRIPT)
engines = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engines)
DEFAULTS = json.loads(Path(__file__).with_name("local-engines.json").read_text())

# Answers the readiness completion like llama-server and records its PID.
FAKE_ENGINE = """#!/usr/bin/env python3
import http.server, json, os, sys
port = int(sys.argv[sys.argv.index("--port") + 1])
open(os.environ["FAKE_ENGINE_PID"], "w").write(str(os.getpid()))
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        body = json.dumps({"choices": [{"message": {"content": "ready"}}]}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass
http.server.HTTPServer(("127.0.0.1", port), Handler).serve_forever()
"""


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def port_closed(port, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
        except ConnectionRefusedError:
            return True
        time.sleep(0.1)
    return False


class PortableEnginesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="copse engines with spaces ")
        self.root = Path(self.temporary.name).resolve()
        self.config = self.root / "engines.json"
        self.config.write_text(json.dumps(DEFAULTS))
        self.models = engines.read_config(self.config)
        self.profile = self.root / "data/copse/user-data"
        self.settings = self.profile / "settings.json"

    def tearDown(self):
        self.temporary.cleanup()

    def install_runtimes(self):
        runtimes = self.root / engines.RUNTIMES
        for executable in (engines.LLAMA, engines.PYTHON):
            path = self.root / executable
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("#!/bin/sh\nexit 1\n")
            path.chmod(0o755)
        (runtimes / engines.RUNTIME_LOCATION).write_text(str(runtimes.resolve()) + "\n")
        return runtimes

    def install_model(self, engine):
        model = self.root / "models" / engine["model"]
        model.parent.mkdir(parents=True, exist_ok=True)
        model.touch()
        return model

    def run_script(self, action):
        return subprocess.run([sys.executable, str(SCRIPT), str(self.root), action],
                              capture_output=True, text=True)

    def test_runtime_paths_come_from_the_pinned_runtime_manifest(self):
        pinned = [line.split("\t", 1)[0] for line in
                  Path(__file__).with_name("runtimes.tsv").read_text().splitlines()]
        self.assertIn(str(engines.LLAMA.parent.relative_to(engines.RUNTIMES)), pinned)
        self.assertIn(str(engines.PYTHON.parent.parent.relative_to(engines.RUNTIMES)), pinned)

    def test_config_rejects_escaping_paths_duplicate_ports_and_invalid_limits(self):
        for key, value in (("model", "../outside"), ("model", "/absolute"),
                           ("port", True), ("port", 80), ("context", 0),
                           ("port", self.models[1]["port"])):
            config = copy.deepcopy(DEFAULTS)
            config["engines"][0][key] = value
            self.config.write_text(json.dumps(config))
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                engines.read_config(self.config)

    def test_settings_preserve_credentials_and_user_selections_and_back_up_changes(self):
        original = {"model": "user:chosen", "apiKey": {"custom": {"v": 1, "enc": "opaque"}},
                    "extraProviders": [{"slug": "my-provider", "label": "Existing"}],
                    "roleModels": {"coder": "user:coder"}, "autoRunSandboxCommands": False}
        engines.atomic_json(self.settings, original)
        engines.configure_settings(self.root, self.models)
        result = json.loads(self.settings.read_text())
        for key in ("model", "apiKey", "roleModels", "autoRunSandboxCommands"):
            self.assertEqual(result[key], original[key])
        # A chosen chat model means routing is the user's, including roles left on automatic.
        for key in engines.ROUTED_KEYS[1:]:
            self.assertNotIn(key, result)
        self.assertEqual(result["extraProviders"][0], original["extraProviders"][0])
        self.assertEqual(len(result["extraProviders"]), 3)
        backup = list(self.profile.glob("settings.before-local-engines-*.json"))
        self.assertEqual(len(backup), 1)
        self.assertEqual(json.loads(backup[0].read_text()), original)
        engines.configure_settings(self.root, self.models)
        self.assertEqual(len(list(self.profile.glob("settings.before-local-engines-*.json"))), 1)

    def test_unconfigured_profile_routes_every_role_including_review_to_the_first_engine(self):
        engines.atomic_json(self.settings, {"smallTasksModel": "user:small"})
        engines.configure_settings(self.root, self.models)
        result = json.loads(self.settings.read_text())
        first = "portable-gguf:" + self.models[0]["id"]
        for key in engines.ROUTED_KEYS:
            self.assertEqual(result[key], first)
        # Roles route through roleModels, which Copse reads before any legacy key; the advisor
        # reads nothing else. A role whose legacy key the user set stays unassigned.
        self.assertEqual(result["roleModels"], {"coder": first, "research": first, "advisor": first})
        self.assertEqual(result["smallTasksModel"], "user:small")
        self.assertNotIn("advisorModel", result)

    def test_existing_role_assignments_are_never_replaced(self):
        engines.atomic_json(self.settings, {"roleModels": {"advisor": "user:advisor"}})
        engines.configure_settings(self.root, self.models)
        result = json.loads(self.settings.read_text())
        self.assertEqual(result["roleModels"]["advisor"], "user:advisor")

    def test_relaunch_keeps_edits_to_drive_providers_and_leaves_unchanged_settings_alone(self):
        engines.configure_settings(self.root, self.models)
        settings = json.loads(self.settings.read_text())
        settings["extraProviders"][0]["label"] = "My drive"
        settings["extraProviders"][0]["models"][0]["inputPricePerMTok"] = 1
        engines.atomic_json(self.settings, settings)
        before = self.settings.stat().st_mtime_ns
        engines.configure_settings(self.root, self.models)
        self.assertEqual(self.settings.stat().st_mtime_ns, before)
        self.assertEqual(json.loads(self.settings.read_text()), settings)
        # The engine still owns where it listens and its context.
        moved = [dict(self.models[0], port=self.models[0]["port"] + 1, context=8192)] + self.models[1:]
        engines.configure_settings(self.root, moved)
        provider = json.loads(self.settings.read_text())["extraProviders"][0]
        self.assertEqual(provider["label"], "My drive")
        self.assertEqual(provider["models"][0]["inputPricePerMTok"], 1)
        self.assertEqual(provider["models"][0]["contextWindow"], 8192)
        self.assertEqual(provider["baseUrl"], "http://127.0.0.1:{}/v1".format(moved[0]["port"]))

    def test_settings_backups_are_pruned_to_the_newest_few(self):
        self.profile.mkdir(parents=True)
        for stamp in range(engines.KEPT_BACKUPS + 3):
            (self.profile / "{}{}.json".format(engines.BACKUP_PREFIX, stamp)).write_text("{}")
        engines.atomic_json(self.settings, {"theme": "dark"})
        engines.configure_settings(self.root, self.models)
        backups = sorted(self.profile.glob(engines.BACKUP_PREFIX + "*.json"), key=engines.backup_time)
        self.assertEqual(len(backups), engines.KEPT_BACKUPS)
        self.assertEqual(json.loads(backups[-1].read_text()), {"theme": "dark"})
        self.assertFalse((self.profile / (engines.BACKUP_PREFIX + "0.json")).exists())

    def test_disable_clears_legacy_selections_written_by_earlier_launchers(self):
        engines.atomic_json(self.settings, {"advisorModel": "portable-gguf:x",
                                            "subagentModel": "user:research"})
        engines.remove_settings(self.root)
        self.assertEqual(json.loads(self.settings.read_text()), {"subagentModel": "user:research"})

    def test_disable_after_routing_an_unconfigured_profile_restores_it(self):
        engines.atomic_json(self.settings, {"theme": "dark"})
        engines.configure_settings(self.root, self.models)
        engines.remove_settings(self.root)
        self.assertEqual(json.loads(self.settings.read_text()), {"theme": "dark", "extraProviders": []})

    def test_disable_removes_drive_providers_and_selections_but_nothing_else(self):
        engines.atomic_json(self.settings, {
            "extraProviders": [{"slug": "my-provider"}],
            "roleModels": {"coder": "user:coder", "research": "portable-mlx:x"},
            "smallTasksModel": "user:small"})
        engines.configure_settings(self.root, self.models)
        engines.remove_settings(self.root)
        result = json.loads(self.settings.read_text())
        self.assertEqual(result, {"extraProviders": [{"slug": "my-provider"}],
                                  "roleModels": {"coder": "user:coder"},
                                  "smallTasksModel": "user:small"})

    def test_disable_action_restores_plain_launches_and_enable_reuses_the_edited_config(self):
        self.install_runtimes()
        engine = dict(self.models[0], context=8192)
        self.install_model(engine)
        data = self.root / "data"
        engines.atomic_json(data / "local-engines.json", {"engines": [engine]})
        self.assertEqual(self.run_script("enable").returncode, 0)
        disabled = self.run_script("disable")
        self.assertEqual(disabled.returncode, 0, disabled.stderr)
        self.assertFalse((data / "local-engines.json").exists())
        self.assertNotIn("portable-gguf", self.settings.read_text())
        enabled = self.run_script("enable")
        self.assertEqual(enabled.returncode, 0, enabled.stderr)
        self.assertEqual(json.loads((data / "local-engines.json").read_text())["engines"], [engine])
        self.assertFalse((data / "local-engines.disabled.json").exists())

    def test_default_enable_starts_with_the_installed_engine_when_the_library_is_absent(self):
        self.install_runtimes()
        self.install_model(self.models[0])
        result = self.run_script("enable")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Skipping the mlx engine", result.stdout)
        config = json.loads((self.root / "data/local-engines.json").read_text())
        self.assertEqual([e["kind"] for e in config["engines"]], ["gguf"])

    def test_live_profile_is_never_rewritten(self):
        self.profile.mkdir(parents=True)
        (self.profile / "SingletonLock").symlink_to("{}-{}".format(socket.gethostname(), os.getpid()))
        with self.assertRaisesRegex(ValueError, "Close the portable"):
            engines.configure_settings(self.root, self.models)
        self.assertFalse(self.settings.exists())

    def test_profile_locked_by_another_mac_names_the_lock_to_clear(self):
        self.profile.mkdir(parents=True)
        (self.profile / "SingletonLock").symlink_to("another-mac.local-123")
        with self.assertRaisesRegex(ValueError, "locked by another-mac.local-123.*SingletonLock"):
            engines.configure_settings(self.root, self.models)
        self.assertFalse(self.settings.exists())

    def test_stale_lock_after_a_crash_or_pulled_drive_does_not_block_launch(self):
        dead = subprocess.Popen(["/bin/sh", "-c", "exit 0"])
        dead.wait()
        self.profile.mkdir(parents=True)
        (self.profile / "SingletonLock").symlink_to("{}-{}".format(socket.gethostname(), dead.pid))
        engines.configure_settings(self.root, self.models)
        self.assertIn("portable-gguf", self.settings.read_text())

    def test_failed_enable_does_not_change_plain_launches(self):
        result = self.run_script("enable")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Model missing", result.stderr)
        self.assertFalse((self.root / "data/local-engines.json").exists())
        self.assertFalse(self.settings.exists())

    def test_relocated_paths_are_single_arguments_and_models_cannot_escape_by_symlink(self):
        self.install_runtimes()
        for engine in self.models:
            model = self.install_model(engine)
            with patch.object(engines.os, "access", return_value=True):
                command = engines.engine_command(self.root, engine)
            self.assertTrue(command[0].startswith(str(self.root)))
            self.assertIn("127.0.0.1", command)
            model.unlink()
            model.symlink_to(self.root / "engines.json")
            with self.assertRaisesRegex(ValueError, "outside drive"):
                engines.engine_command(self.root, engine)

    def test_runtimes_prepared_at_another_mount_path_must_be_repaired(self):
        runtimes = self.install_runtimes()
        self.install_model(self.models[0])
        (runtimes / engines.RUNTIME_LOCATION).write_text("/Volumes/Drive/old\n")
        with patch.object(engines.os, "access", return_value=True):
            with self.assertRaisesRegex(ValueError, "prepared at /Volumes/Drive/old.*runtimes-offline"):
                engines.engine_command(self.root, self.models[0])

    def test_readiness_reports_engine_exit_without_adopting_a_server(self):
        child = subprocess.Popen(["/bin/sh", "-c", "exit 7"])
        child.wait()
        with patch.object(engines.urllib.request, "urlopen") as fetch:
            with self.assertRaisesRegex(RuntimeError, "gguf exited"):
                engines.wait_ready(child, self.models[0], Path("gguf.log"))
            fetch.assert_not_called()

    def test_readiness_retries_a_connection_dropped_while_loading(self):
        child = subprocess.Popen(["/bin/sh", "-c", "sleep 30"])
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.read.return_value = b'{"choices": [{}]}'
        try:
            with patch.object(engines.urllib.request, "urlopen", side_effect=[
                    http.client.RemoteDisconnected("loading"), ConnectionResetError(), response]), \
                    patch.object(engines.time, "sleep"):
                engines.wait_ready(child, self.models[0], Path("gguf.log"))
        finally:
            child.kill()
            child.wait()

    def test_cleanup_only_signals_live_owned_children(self):
        child = subprocess.Popen(["/bin/sh", "-c", "sleep 30"], start_new_session=True)
        other = subprocess.Popen(["/bin/sh", "-c", "sleep 30"], start_new_session=True)
        try:
            engines.stop([child])
            self.assertIsNotNone(child.poll())
            self.assertIsNone(other.poll())
        finally:
            engines.stop([child, other])

    def test_watchdog_stops_the_engine_when_the_supervisor_pipe_closes(self):
        child = subprocess.Popen(["/bin/sh", "-c", "sleep 30"], start_new_session=True)
        guard, guard_write = os.pipe()
        watchdog = engines.start_watchdog(child, guard)
        try:
            os.close(guard)
            os.close(guard_write)
            self.assertEqual(child.wait(timeout=15), -signal.SIGTERM)
            self.assertEqual(watchdog.wait(timeout=15), 0)
        finally:
            engines.stop([child], [watchdog])

    def serve(self):
        self.install_runtimes()
        (self.root / engines.LLAMA).write_text(FAKE_ENGINE)
        engine = dict(self.models[0], port=free_port(), context=4096)
        self.install_model(engine)
        engines.atomic_json(self.root / "data/local-engines.json", {"engines": [engine]})
        supervisor = subprocess.Popen(
            [sys.executable, str(SCRIPT), str(self.root), "serve"], stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
            env=dict(os.environ, FAKE_ENGINE_PID=str(self.root / "engine.pid")))
        for line in supervisor.stdout:
            if line.startswith("Engines ready"):
                return supervisor, engine["port"]
        supervisor.wait()
        self.fail("serve did not start: " + supervisor.stderr.read())

    def test_closing_the_launch_terminal_stops_the_engines(self):
        supervisor, port = self.serve()
        supervisor.send_signal(signal.SIGHUP)
        self.assertEqual(supervisor.wait(timeout=30), 130)
        self.assertTrue(port_closed(port))
        supervisor.stdout.close()
        supervisor.stderr.close()

    def test_engines_do_not_outlive_a_killed_supervisor(self):
        supervisor, port = self.serve()
        supervisor.kill()
        supervisor.wait()
        self.assertTrue(port_closed(port), "the watchdog should stop the orphaned engine")
        supervisor.stdout.close()
        supervisor.stderr.close()


if __name__ == "__main__":
    unittest.main()
