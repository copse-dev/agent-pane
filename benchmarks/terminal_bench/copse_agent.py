"""Harbor external-agent adapter for the headless Copse agent loop."""

from __future__ import annotations

import asyncio
import json
import os
from collections import deque
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


_MAX_TOOL_OUTPUT_CHARS = 40_000
_DEFAULT_COMMAND_TIMEOUT_SEC = 120
_TRACE_BUFFER_MAX_LINES = 256
_TRACE_BUFFER_MAX_CHARS = 64_000


def _bounded_output(value: str | None) -> str:
    text = value or ""
    if len(text) <= _MAX_TOOL_OUTPUT_CHARS:
        return text
    half = _MAX_TOOL_OUTPUT_CHARS // 2
    omitted = len(text) - (half * 2)
    return f"{text[:half]}\n... {omitted} chars omitted ...\n{text[-half:]}"


def _is_command_timeout(error: BaseException) -> bool:
    return isinstance(error, TimeoutError) or (
        isinstance(error, RuntimeError)
        and str(error).startswith("Command timed out after ")
        and str(error).endswith(" seconds")
    )


class CopseTerminalAgent(BaseAgent):
    """Run Copse on the host and forward shell calls into a Harbor environment."""

    @staticmethod
    def name() -> str:
        return "copse-terminal"

    def version(self) -> str | None:
        return os.environ.get("COPSE_BENCH_AGENT_VERSION", "local")

    async def setup(self, environment: BaseEnvironment) -> None:
        del environment

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        bundle_value = os.environ.get("COPSE_TERMINAL_AGENT_BUNDLE")
        if not bundle_value:
            raise RuntimeError(
                "COPSE_TERMINAL_AGENT_BUNDLE is unset; launch with npm run bench:terminal."
            )
        bundle = Path(bundle_value).resolve()
        if not bundle.is_file():
            raise RuntimeError(f"Terminal agent bundle does not exist: {bundle}")
        if not self.model_name:
            raise RuntimeError("A model is required; pass --model or set LM_STUDIO_MODEL.")

        command_timeout = int(
            os.environ.get(
                "COPSE_TERMINAL_COMMAND_TIMEOUT_SEC",
                str(_DEFAULT_COMMAND_TIMEOUT_SEC),
            )
        )
        if command_timeout <= 0:
            raise ValueError("COPSE_TERMINAL_COMMAND_TIMEOUT_SEC must be positive.")
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        trace_path = self.logs_dir / "copse-trace.jsonl"
        context.n_input_tokens = 0
        context.n_output_tokens = 0
        context.metadata = {
            "tool_calls": 0,
            "model_requests": 0,
            "command_timeouts": 0,
            "stop_reason": None,
            "trace": trace_path.name,
            "applied_nudges": "applied-nudges.jsonl",
            "hook_runs": "hook-runs.jsonl",
            "stream_stats": "stream-stats.jsonl",
            "thread": "thread/events.jsonl",
            "thread_export": "thread/thread.jsonl",
        }
        stderr_tail: deque[str] = deque(maxlen=80)
        process = await asyncio.create_subprocess_exec(
            "node",
            str(bundle),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=os.environ.copy(),
        )
        if process.stdin is None or process.stdout is None or process.stderr is None:
            raise RuntimeError("Failed to open terminal agent bridge pipes.")

        async def drain_stderr() -> None:
            async for raw in process.stderr:
                line = raw.decode("utf-8", errors="replace").rstrip()
                stderr_tail.append(line)
                self.logger.debug("terminal agent: %s", line)

        stderr_task = asyncio.create_task(drain_stderr())

        async def send(message: dict[str, Any]) -> None:
            process.stdin.write((json.dumps(message) + "\n").encode())
            await process.stdin.drain()

        result_message: dict[str, Any] | None = None
        try:
            await send(
                {
                    "type": "start",
                    "instruction": instruction,
                    "model": self.model_name,
                    "threadDir": str(self.logs_dir / "thread"),
                }
            )
            with trace_path.open("w", encoding="utf-8") as trace:
                trace_buffer: list[str] = []
                trace_buffer_chars = 0

                def flush_trace() -> None:
                    nonlocal trace_buffer_chars
                    if not trace_buffer:
                        return
                    trace.writelines(trace_buffer)
                    trace.flush()
                    trace_buffer.clear()
                    trace_buffer_chars = 0

                def append_trace(event: Any) -> None:
                    nonlocal trace_buffer_chars
                    line = json.dumps(event) + "\n"
                    trace_buffer.append(line)
                    trace_buffer_chars += len(line)
                    if isinstance(event, dict):
                        event_type = event.get("type")
                        if event_type == "tool_call":
                            context.metadata["tool_calls"] += 1
                        elif event_type == "usage":
                            context.metadata["model_requests"] += 1
                            context.n_input_tokens += int(event.get("inputTokens", 0))
                            context.n_output_tokens += int(event.get("outputTokens", 0))
                        elif event_type == "done":
                            context.metadata["stop_reason"] = event.get("stopReason")
                    if (
                        len(trace_buffer) >= _TRACE_BUFFER_MAX_LINES
                        or trace_buffer_chars >= _TRACE_BUFFER_MAX_CHARS
                    ):
                        flush_trace()

                async for raw in process.stdout:
                    message = json.loads(raw)
                    message_type = message.get("type")
                    if message_type == "event":
                        append_trace(message["event"])
                        continue
                    if message_type == "events":
                        events = message.get("events")
                        if not isinstance(events, list):
                            raise RuntimeError("Terminal agent sent an invalid event batch.")
                        for event in events:
                            append_trace(event)
                        continue
                    if message_type == "tool_request":
                        flush_trace()
                        command = message.get("command")
                        tool_id = message.get("id")
                        if not isinstance(command, str) or not isinstance(tool_id, str):
                            raise RuntimeError("Terminal agent sent an invalid tool request.")
                        try:
                            shell_result = await environment.exec(
                                command,
                                timeout_sec=command_timeout,
                            )
                        except (TimeoutError, RuntimeError) as error:
                            if not _is_command_timeout(error):
                                raise
                            context.metadata["command_timeouts"] += 1
                            await send(
                                {
                                    "type": "tool_result",
                                    "id": tool_id,
                                    "exitCode": 124,
                                    "stdout": "",
                                    "stderr": (
                                        "Command timed out after "
                                        f"{command_timeout} seconds. Narrow the work to a "
                                        "bounded subset or use a different approach; do not "
                                        "rerun an equivalent command unchanged."
                                    ),
                                }
                            )
                            continue
                        await send(
                            {
                                "type": "tool_result",
                                "id": tool_id,
                                "exitCode": shell_result.return_code,
                                "stdout": _bounded_output(shell_result.stdout),
                                "stderr": _bounded_output(shell_result.stderr),
                            }
                        )
                        continue
                    if message_type == "result":
                        flush_trace()
                        result_message = message
                        continue
                    raise RuntimeError(
                        f"Terminal agent sent an unknown protocol message: {message_type!r}"
                    )
                flush_trace()

            return_code = await process.wait()
            await stderr_task
            if return_code != 0:
                detail = "\n".join(stderr_tail) or "no stderr"
                raise RuntimeError(
                    f"Terminal agent exited with code {return_code}:\n{detail}"
                )
            if result_message is None:
                raise RuntimeError("Terminal agent exited without a result message.")

            context.n_input_tokens = int(result_message.get("inputTokens", 0))
            context.n_output_tokens = int(result_message.get("outputTokens", 0))
            context.metadata["tool_calls"] = int(result_message.get("toolCalls", 0))
            context.metadata["model_requests"] = int(result_message.get("llmCalls", 0))
            context.metadata["command_timeouts"] = int(
                result_message.get("commandTimeouts", 0)
            )
            context.metadata["stop_reason"] = result_message.get("stopReason")
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            if not stderr_task.done():
                stderr_task.cancel()
            await asyncio.gather(stderr_task, return_exceptions=True)
