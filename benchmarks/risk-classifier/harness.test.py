"""The risk-classifier harness's rules and policy logic, without any dataset or model.

    python3 -I benchmarks/risk-classifier/harness.test.py
"""
import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from data import normalise  # noqa: E402
from rules import must_ask  # noqa: E402
from train import decide, score  # noqa: E402

REGRESSION = HERE.parent / "escalation-review" / "regression" / "cases.jsonl"


class RulesTest(unittest.TestCase):
    def test_agree_with_the_release_regression_cases(self):
        # The product rules (release-actions.ts) are pinned by these cases; the experiment's copy
        # must agree on every one, or the replay measures a different gate.
        release_ids = {
            "gy-source-release-env-then-use",
            "gy-source-release-env-presence-check",
            "gy-bash-c-source-env-sign",
            "gy-make-ship-release",
            "gy-make-ship-release-other-checkout",
            "gy-sign-update-direct",
            "gy-force-tag-and-push",
            "gy-push-with-credential-helper-override",
            "gy-make-bundle-release-log",
            "gy-pnpm-script-released-ref",
            "gy-make-release-dry-run",
            "gy-push-branch-head",
        }
        seen = set()
        for line in REGRESSION.read_text().splitlines():
            case = json.loads(line)
            if case["id"] not in release_ids:
                continue
            seen.add(case["id"])
            expected = case["expect"]["harm"] == "prompt"
            self.assertEqual(bool(must_ask(case["command"])), expected, case["id"])
        self.assertEqual(seen, release_ids)


class PolicyTest(unittest.TestCase):
    row = {"text": "git status", "tier": "read", "harm": "allow", "weight": 2}
    confident = {"tier": "read", "p_ask": 0.01}

    def test_never_approves_what_the_harm_gate_asks_about(self):
        self.assertFalse(decide({**self.row, "harm": "prompt"}, self.confident, "outside-read", 0.5, True))
        self.assertFalse(decide({**self.row, "harm": "prompt"}, None, "outside-read", 0.5, True))

    def test_never_approves_a_must_ask_rule(self):
        row = {**self.row, "text": "make ship-release VERSION=1"}
        self.assertFalse(decide(row, self.confident, "outside-read", 0.5, True))

    def test_needs_a_confident_in_mode_prediction(self):
        self.assertTrue(decide(self.row, self.confident, "outside-read", 0.05, True))
        self.assertFalse(decide(self.row, {"tier": "read", "p_ask": 0.2}, "outside-read", 0.05, True))
        self.assertFalse(decide(self.row, {"tier": "outside-write", "p_ask": 0.01}, "outside-read", 0.05, True))

    def test_harm_key_selects_the_gate(self):
        row = {**self.row, "harm": "prompt", "harm_main": "allow"}
        self.assertTrue(decide(row, None, "outside-read", 1.0, False, "harm_main"))
        self.assertFalse(decide(row, None, "outside-read", 1.0, False))

    def test_score_counts_prompts_and_missed_asks(self):
        rows = [self.row, {**self.row, "tier": "ask", "weight": 1}]
        result = score(rows, [self.confident, self.confident], "outside-read", 0.05, False)
        self.assertEqual((result["prompts"], result["removed"], result["ask_approved"]), (3, 3, 1))


class NormaliseTest(unittest.TestCase):
    def test_replaces_machine_paths(self):
        text = normalise(
            "cd /Users/alex/.copse/worktrees/11111111-2222-3333-4444-555555555555/66666666-7777-8888-9999-000000000000 && cat /Users/alex/x /work/p/src",
            workspace="/work/p",
        )
        self.assertEqual(text, "cd $WT && cat ~/x $WS/src")


if __name__ == "__main__":
    unittest.main()
