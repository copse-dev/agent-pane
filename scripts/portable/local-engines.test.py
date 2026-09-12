"""Regression coverage for portable process ownership and profile/config boundaries."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("local_engines", Path(__file__).with_name("local-engines.py"))
engines = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engines)
DEFAULTS = json.loads(Path(__file__).with_name("local-engines.json").read_text())


class PortableEnginesTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="copse engines with spaces ")
        self.root = Path(self.temporary.name)
        self.config = self.root / "engines.json"
        self.config.write_text(json.dumps(DEFAULTS))
        self.models = engines.read_config(self.config)

    def tearDown(self):
        self.temporary.cleanup()

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
        path = self.root / "data/copse/user-data/settings.json"
        original = {"model": "user:chosen", "apiKey": {"custom": {"v": 1, "enc": "opaque"}},
                    "extraProviders": [{"slug": "my-provider", "label": "Existing"}],
                    "roleModels": {"coder": "user:coder"}, "autoRunSandboxCommands": False}
        engines.atomic_json(path, original)
        engines.configure_settings(self.root, self.models)
        result = json.loads(path.read_text())
        for key in ("model", "apiKey", "roleModels", "autoRunSandboxCommands"):
            self.assertEqual(result[key], original[key])
        self.assertEqual(result["extraProviders"][0], original["extraProviders"][0])
        self.assertEqual(len(result["extraProviders"]), 3)
        backup = list(path.parent.glob("settings.before-local-engines-*.json"))
        self.assertEqual(len(backup), 1)
        self.assertEqual(json.loads(backup[0].read_text()), original)
        engines.configure_settings(self.root, self.models)
        self.assertEqual(len(list(path.parent.glob("settings.before-local-engines-*.json"))), 1)

    def test_active_profile_is_never_rewritten(self):
        profile = self.root / "data/copse/user-data"
        profile.mkdir(parents=True)
        (profile / "SingletonLock").symlink_to("some-host-123")
        with self.assertRaisesRegex(ValueError, "Close the portable"):
            engines.configure_settings(self.root, self.models)
        self.assertFalse((profile / "settings.json").exists())

    def test_failed_enable_does_not_change_plain_launches(self):
        result = subprocess.run(["python3", str(engines.SOURCE / "local-engines.py"),
                                 str(self.root), "enable"], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Model missing", result.stderr)
        self.assertFalse((self.root / "data/local-engines.json").exists())
        self.assertFalse((self.root / "data/copse/user-data/settings.json").exists())

    def test_relocated_paths_are_single_arguments_and_models_cannot_escape_by_symlink(self):
        for engine in self.models:
            model = self.root / "models" / engine["model"]
            model.parent.mkdir(parents=True, exist_ok=True)
            model.touch()
            with patch.object(engines.os, "access", return_value=True):
                command = engines.engine_command(self.root, engine)
            self.assertTrue(command[0].startswith(str(self.root)))
            self.assertIn("127.0.0.1", command)
            model.unlink()
            model.symlink_to(self.root / "engines.json")
            with self.assertRaisesRegex(ValueError, "outside drive"):
                engines.engine_command(self.root, engine)

    def test_readiness_reports_engine_exit_without_adopting_a_server(self):
        child = subprocess.Popen(["/bin/sh", "-c", "exit 7"])
        child.wait()
        with patch.object(engines.urllib.request, "urlopen") as fetch:
            with self.assertRaisesRegex(RuntimeError, "gguf exited"):
                engines.wait_ready(child, self.models[0], Path("gguf.log"))
            fetch.assert_not_called()

    def test_cleanup_only_signals_live_owned_children(self):
        child = subprocess.Popen(["/bin/sh", "-c", "sleep 30"], start_new_session=True)
        other = subprocess.Popen(["/bin/sh", "-c", "sleep 30"], start_new_session=True)
        try:
            engines.stop([child])
            self.assertIsNotNone(child.poll())
            self.assertIsNone(other.poll())
        finally:
            engines.stop([child, other])


if __name__ == "__main__":
    unittest.main()
