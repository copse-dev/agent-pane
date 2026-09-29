"""Predeclared SkillsBench trial-validity policy."""

from __future__ import annotations

from typing import Any


MINIMUM_WORK_POLICY = {
    "id": "minimum-work-v1",
    "minimumInputTokens": 1000,
    "minimumToolCalls": 1,
}


def classify_trial(n_input_tokens: Any, n_tool_calls: Any) -> dict[str, str | None]:
    """Classify a trial before its verifier reward enters an aggregate."""
    input_tokens = int(n_input_tokens or 0)
    tool_calls = int(n_tool_calls or 0)
    deficits: list[str] = []
    if input_tokens < MINIMUM_WORK_POLICY["minimumInputTokens"]:
        deficits.append(
            f"input tokens {input_tokens} < {MINIMUM_WORK_POLICY['minimumInputTokens']}"
        )
    if tool_calls < MINIMUM_WORK_POLICY["minimumToolCalls"]:
        deficits.append(
            f"tool calls {tool_calls} < {MINIMUM_WORK_POLICY['minimumToolCalls']}"
        )
    if deficits:
        return {"status": "void", "reason": "; ".join(deficits)}
    return {"status": "scored", "reason": None}
