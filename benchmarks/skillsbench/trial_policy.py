"""Predeclared SkillsBench trial-validity policy."""

from __future__ import annotations

from typing import Any


MINIMUM_WORK_POLICY = {
    "id": "minimum-work-v1",
    "minimumInputTokens": 1000,
    "minimumToolCalls": 1,
}


def classify_trial(n_input_tokens: Any, n_tool_calls: Any) -> dict[str, str | None]:
    """Classify a trial before its verifier reward enters an aggregate.

    A count the runner did not report is void too (it cannot show the minimum
    work), but the reason says it was missing rather than that it was zero.
    """
    deficits: list[str] = []
    if n_input_tokens is None:
        deficits.append("input tokens not reported")
    elif int(n_input_tokens) < MINIMUM_WORK_POLICY["minimumInputTokens"]:
        deficits.append(
            f"input tokens {int(n_input_tokens)} < {MINIMUM_WORK_POLICY['minimumInputTokens']}"
        )
    if n_tool_calls is None:
        deficits.append("tool calls not reported")
    elif int(n_tool_calls) < MINIMUM_WORK_POLICY["minimumToolCalls"]:
        deficits.append(
            f"tool calls {int(n_tool_calls)} < {MINIMUM_WORK_POLICY['minimumToolCalls']}"
        )
    if deficits:
        return {"status": "void", "reason": "; ".join(deficits)}
    return {"status": "scored", "reason": None}
