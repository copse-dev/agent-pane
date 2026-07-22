"""Harbor external-agent adapter for the headless Copse agent loop."""

from __future__ import annotations

import asyncio
import json
import os
import shlex
from collections import deque
from pathlib import Path
from typing import Any

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


_MAX_TOOL_OUTPUT_CHARS = 40_000
_DEFAULT_COMMAND_TIMEOUT_SEC = 120
_DEFAULT_MAX_COMMAND_TIMEOUT_SEC = 600
_TRACE_BUFFER_MAX_LINES = 256
_TRACE_BUFFER_MAX_CHARS = 64_000
_DEFAULT_WORKSPACE_CAP_MB = 500


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

    async def _capture_workspace(
        self,
        environment: BaseEnvironment,
        workspace_root: str,
        context: AgentContext,
    ) -> None:
        cap_mb = int(
            os.environ.get(
                "COPSE_TERMINAL_WORKSPACE_CAP_MB",
                str(_DEFAULT_WORKSPACE_CAP_MB),
            )
        )
        if cap_mb < 0:
            raise ValueError("COPSE_TERMINAL_WORKSPACE_CAP_MB must be non-negative.")
        snapshot = {
            "root": workspace_root,
            "cap_mb": cap_mb,
            "manifest": "workspace-files.tsv",
            "archive": None,
            "archive_bytes": None,
            "status": "disabled" if cap_mb == 0 else "capturing",
        }
        context.metadata["workspace_snapshot"] = snapshot
        if cap_mb == 0:
            return
        if workspace_root == "/":
            snapshot["status"] = "unsafe-root"
            return

        quoted_root = shlex.quote(workspace_root)
        remote_manifest = "/tmp/copse-workspace-files.tsv"
        remote_archive = "/tmp/copse-workspace-final.tar.gz"
        try:
            manifest_result = await environment.exec(
                f"find {quoted_root} -xdev -type f "
                f"-printf '%P\\t%s\\t%T@\\n' | sort > {remote_manifest}",
                timeout_sec=120,
                user="root",
            )
            if manifest_result.return_code == 0:
                await environment.download_file(
                    remote_manifest,
                    self.logs_dir / "workspace-files.tsv",
                )

            tar_result = await environment.exec(
                "tar --ignore-failed-read "
                "--exclude='./copse-workspace-files.tsv' "
                "--exclude='./copse-workspace-final.tar.gz' "
                f"-czf {remote_archive} -C {quoted_root} .",
                timeout_sec=300,
                user="root",
            )
            if tar_result.return_code != 0:
                snapshot["status"] = "archive-error"
                snapshot["error"] = _bounded_output(
                    tar_result.stderr or tar_result.stdout
                )
                return
            size_result = await environment.exec(
                f"wc -c < {remote_archive}",
                timeout_sec=30,
                user="root",
            )
            if size_result.return_code != 0 or not (size_result.stdout or "").strip().isdigit():
                snapshot["status"] = "size-error"
                return
            archive_bytes = int((size_result.stdout or "0").strip())
            snapshot["archive_bytes"] = archive_bytes
            if archive_bytes > cap_mb * 1024 * 1024:
                snapshot["status"] = "over-cap"
                return
            await environment.download_file(
                remote_archive,
                self.logs_dir / "workspace-final.tar.gz",
            )
            snapshot["archive"] = "workspace-final.tar.gz"
            snapshot["status"] = "captured"
        except Exception as error:  # noqa: BLE001 - retention must not replace benchmark outcome
            snapshot["status"] = "capture-error"
            snapshot["error"] = str(error)
            self.logger.warning("Unable to retain final workspace: %s", error)
        finally:
            try:
                await environment.exec(
                    f"rm -f {remote_manifest} {remote_archive}",
                    timeout_sec=30,
                    user="root",
                )
            except Exception as error:  # noqa: BLE001 - best-effort temporary cleanup
                self.logger.warning("Unable to remove workspace transfer files: %s", error)

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
        max_command_timeout = int(
            os.environ.get(
                "COPSE_TERMINAL_MAX_COMMAND_TIMEOUT_SEC",
                str(_DEFAULT_MAX_COMMAND_TIMEOUT_SEC),
            )
        )
        if max_command_timeout < command_timeout:
            raise ValueError(
                "COPSE_TERMINAL_MAX_COMMAND_TIMEOUT_SEC must be at least "
                "COPSE_TERMINAL_COMMAND_TIMEOUT_SEC."
            )
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        trace_path = self.logs_dir / "copse-trace.jsonl"
        workspace_result = await environment.exec("pwd", timeout_sec=30)
        workspace_root = (workspace_result.stdout or "/").strip() or "/"
        context.n_input_tokens = 0
        context.n_output_tokens = 0
        profile_id = os.environ.get("COPSE_TERMINAL_PROFILE", "main-legacy")
        profile = profile_id if "@" in profile_id else f"{profile_id}@1"
        context.metadata = {
            "tool_calls": 0,
            "model_requests": 0,
            "command_timeouts": 0,
            "stop_reason": None,
            "trace": trace_path.name,
            "provider_requests": "provider-requests.jsonl",
            "applied_nudges": "applied-nudges.jsonl",
            "hook_runs": "hook-runs.jsonl",
            "stream_stats": "stream-stats.jsonl",
            "thread": "thread/events.jsonl",
            "thread_export": "thread/thread.jsonl",
            "parent_trial_id": os.environ.get("COPSE_TERMINAL_PARENT_TRIAL_ID"),
            "intervention_id": os.environ.get("COPSE_TERMINAL_INTERVENTION_ID"),
            "profile": profile,
            "profile_hash": os.environ.get("COPSE_TERMINAL_PROFILE_HASH"),
            "workspace_root": workspace_root,
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
                        requested_timeout = message.get("timeoutSec")
                        if requested_timeout is None:
                            effective_timeout = command_timeout
                        elif (
                            isinstance(requested_timeout, bool)
                            or not isinstance(requested_timeout, int)
                            or requested_timeout <= 0
                        ):
                            raise RuntimeError(
                                "Terminal agent sent an invalid command timeout."
                            )
                        else:
                            effective_timeout = min(
                                requested_timeout, max_command_timeout
                            )
                        try:
                            shell_result = await environment.exec(
                                command,
                                timeout_sec=effective_timeout,
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
                                        f"{effective_timeout} seconds. Narrow the work to a "
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
            if result_message.get("profile"):
                context.metadata["profile"] = result_message["profile"]
            if result_message.get("profileHash"):
                context.metadata["profile_hash"] = result_message["profileHash"]
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
            await self._capture_workspace(environment, workspace_root, context)
