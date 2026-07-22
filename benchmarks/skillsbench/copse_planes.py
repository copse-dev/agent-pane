"""BenchFlow 0.6.3 composition plane that runs the Copse headless agent.

BenchFlow still owns task images, skill deployment, lifecycle, and verification.
Only the ACP agent execution plane is replaced by the repository's bundled
``runAgentLoop`` bridge.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import shlex
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from benchflow.acp.session import ACPSession
from benchflow.agents.registry import AgentConfig
from benchflow.rollout_planes import DefaultRolloutPlanes
from benchflow.task.config import NetworkMode
from benchflow.trajectories._capture import _capture_session_trajectory


AGENT_CONFIG = AgentConfig(
    name="copse-skillsbench",
    install_cmd="true",
    launch_cmd="copse-skillsbench",
    protocol="acp",
    skill_paths=["$HOME/.agents/skills"],
)


class _SessionAdapter:
    def on_ask_user(self, _handler: Any) -> None:
        return None


@dataclass
class _CopseClient:
    env: Any
    session: ACPSession
    agent_cwd: str
    agent_env: dict[str, str]
    model: str
    bundle: Path
    profile: str
    skills: list[dict[str, str]]
    process: asyncio.subprocess.Process | None = None

    def on_ask_user(self, _handler: Any) -> None:
        return None

    async def close(self) -> None:
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        self.process = None


def _frontmatter_value(body: str, key: str) -> str:
    if not body.startswith("---"):
        return ""
    parts = body.split("---", 2)
    if len(parts) < 3:
        return ""
    try:
        frontmatter = yaml.safe_load(parts[1]) or {}
    except yaml.YAMLError:
        return ""
    value = frontmatter.get(key) if isinstance(frontmatter, dict) else None
    return value.strip() if isinstance(value, str) else ""


async def _load_skills(env: Any) -> list[dict[str, str]]:
    command = (
        "for f in /skills/*/SKILL.md; do "
        '[ -f "$f" ] || continue; '
        'printf \'%s\\t\' "$(basename "$(dirname "$f")")"; '
        'base64 "$f" | tr -d \'\\n\'; printf \'\\n\'; '
        "done"
    )
    result = await env.exec(command, timeout_sec=30)
    if result.return_code != 0:
        raise RuntimeError(f"could not enumerate /skills: {result.stderr or result.stdout}")
    skills: list[dict[str, str]] = []
    for line in (result.stdout or "").splitlines():
        name, separator, encoded = line.partition("\t")
        if not separator or not name:
            continue
        body = base64.b64decode(encoded).decode("utf-8", errors="replace")
        skills.append(
            {
                "name": name,
                "description": _frontmatter_value(body, "description"),
                "body": body,
            }
        )
    return sorted(skills, key=lambda skill: skill["name"])


def _tool_content(text: str) -> list[dict[str, Any]]:
    return [{"type": "content", "content": {"type": "text", "text": text}}]


def _record_event(session: ACPSession, event: dict[str, Any]) -> None:
    event_type = event.get("type")
    if event_type == "text":
        session.handle_update(
            {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": event.get("text", "")},
            }
        )
    elif event_type == "text_replace":
        session.handle_update(
            {"sessionUpdate": "text_update", "text": event.get("text", "")}
        )
    elif event_type == "reasoning":
        session.handle_update(
            {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": event.get("text", "")},
            }
        )
    elif event_type == "tool_call":
        tool_call = event.get("toolCall") or {}
        name = str(tool_call.get("name") or "tool")
        args = tool_call.get("args") or {}
        title = str(args.get("command") or args.get("path") or name)
        session.handle_update(
            {
                "sessionUpdate": "tool_call",
                "toolCallId": str(tool_call.get("id") or ""),
                "title": title,
                "kind": "skill" if name == "read_skill" else "execute",
            }
        )
    elif event_type == "tool_result":
        result = str(event.get("result") or "")
        session.handle_update(
            {
                "sessionUpdate": "tool_call_update",
                "toolCallId": str(event.get("toolCallId") or ""),
                "status": "failed" if event.get("isError") else "completed",
                "content": _tool_content(result),
            }
        )


async def _read_skill(client: _CopseClient, skill: str, path: str) -> tuple[str, bool]:
    known = {entry["name"] for entry in client.skills}
    if skill not in known:
        return f"Unknown benchmark skill '{skill}'.", True
    if not path or path.startswith("/") or ".." in Path(path).parts:
        return "read_skill path must be relative and remain inside the skill directory.", True
    root = f"/skills/{skill}"
    target = f"{root}/{path}"
    command = (
        f"root=$(readlink -f -- {shlex.quote(root)}) || exit 40; "
        f"target=$(readlink -f -- {shlex.quote(target)}) || exit 41; "
        'case "$target" in "$root"|"$root"/*) ;; *) exit 42;; esac; '
        '[ -f "$target" ] || exit 43; '
        'size=$(wc -c < "$target"); [ "$size" -le 1048576 ] || exit 44; '
        'base64 "$target" | tr -d \'\\n\''
    )
    result = await client.env.exec(command, cwd=client.agent_cwd, timeout_sec=30)
    if result.return_code != 0:
        reasons = {
            40: "skill root is unavailable",
            41: "skill resource does not exist",
            42: "skill resource escapes its skill directory",
            43: "skill resource is not a regular file",
            44: "skill resource exceeds the 1 MiB read limit",
        }
        return reasons.get(result.return_code, result.stderr or "skill read failed"), True
    try:
        body = base64.b64decode(result.stdout or "").decode("utf-8", errors="replace")
        description = next(
            (entry["description"] for entry in client.skills if entry["name"] == skill), ""
        )
        header = [f"# Skill: {skill}", f"Root: {root}", f"File: {path}"]
        if description:
            header.extend(["", f"Description: {description}"])
        return "\n".join([*header, "", "---", "", body]), False
    except ValueError as error:
        return f"skill resource was not valid base64: {error}", True


async def _handle_tool(client: _CopseClient, request: dict[str, Any]) -> dict[str, Any]:
    tool = request.get("tool")
    if tool == "run_shell":
        timeout = request.get("timeoutSec")
        timeout_sec = int(timeout) if isinstance(timeout, (int, float)) else 120
        try:
            result = await client.env.exec(
                str(request.get("command") or ""),
                cwd=client.agent_cwd,
                timeout_sec=timeout_sec,
            )
            output = (
                f"exit_code={result.return_code}\n"
                f"stdout:\n{result.stdout or ''}\n"
                f"stderr:\n{result.stderr or ''}"
            )
            is_error = result.return_code != 0
        except (TimeoutError, RuntimeError) as error:
            if "timed out" not in str(error).lower():
                raise
            output = f"Command timed out after {timeout_sec} seconds."
            is_error = True
    elif tool == "read_skill":
        output, is_error = await _read_skill(
            client,
            str(request.get("skill") or ""),
            str(request.get("path") or "SKILL.md"),
        )
    else:
        output, is_error = f"Unsupported bridge tool '{tool}'.", True
    return {
        "type": "tool_result",
        "id": str(request.get("id") or ""),
        "result": output,
        "isError": is_error,
    }


async def _drain_stderr(stream: asyncio.StreamReader | None, sink: list[str]) -> None:
    if stream is None:
        return
    while True:
        line = await stream.readline()
        if not line:
            return
        sink.append(line.decode(errors="replace"))


async def _run_prompt(client: _CopseClient, prompt: str) -> dict[str, Any]:
    # Do not inherit the worker's Scaleway, registry, or Object Storage
    # credentials. The headless bridge needs only its provider credentials and
    # a minimal process environment.
    process_env = {
        name: os.environ[name]
        for name in ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NODE_EXTRA_CA_CERTS")
        if os.environ.get(name)
    }
    process_env.update(client.agent_env)
    process = await asyncio.create_subprocess_exec(
        "node",
        str(client.bundle),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=process_env,
    )
    client.process = process
    assert process.stdin is not None
    assert process.stdout is not None
    start = {
        "type": "start",
        "instruction": prompt,
        "model": client.model,
        "profile": client.profile,
        "skills": client.skills,
    }
    process.stdin.write((json.dumps(start) + "\n").encode())
    await process.stdin.drain()
    stderr: list[str] = []
    stderr_task = asyncio.create_task(_drain_stderr(process.stderr, stderr))
    final: dict[str, Any] | None = None
    try:
        while True:
            line = await process.stdout.readline()
            if not line:
                break
            message = json.loads(line)
            if message.get("type") == "event":
                event = message.get("event")
                if isinstance(event, dict):
                    _record_event(client.session, event)
            elif message.get("type") == "tool_request":
                response = await _handle_tool(client, message)
                process.stdin.write((json.dumps(response) + "\n").encode())
                await process.stdin.drain()
            elif message.get("type") == "result":
                final = message
        code = await process.wait()
        await stderr_task
        if code != 0 or final is None:
            detail = "".join(stderr).strip()
            raise RuntimeError(detail or f"Copse bridge exited {code} without a result")
        client.session.record_prompt_usage(
            {
                "input_tokens": final.get("inputTokens", 0),
                "output_tokens": final.get("outputTokens", 0),
                "total_tokens": int(final.get("inputTokens", 0))
                + int(final.get("outputTokens", 0)),
            }
        )
        return final
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
            with contextlib.suppress(asyncio.CancelledError):
                await stderr_task
        client.process = None


class CopseRolloutPlanes(DefaultRolloutPlanes):
    def __init__(self, *, bundle: Path, profile: str) -> None:
        super().__init__()
        self.bundle = bundle
        self.profile = profile
        self.last_result: dict[str, Any] | None = None

    def agent_launch(self, agent: str, *, disallow_web_tools: bool) -> str:
        del agent, disallow_web_tools
        return ""

    def agent_config(self, agent: str) -> AgentConfig:
        del agent
        return AGENT_CONFIG

    def resolve_agent_env(
        self, agent: str, model: str | None, agent_env: dict[str, str] | None
    ) -> dict[str, str]:
        del agent, model
        return dict(agent_env or {})

    def create_environment(
        self,
        environment: str,
        task: Any,
        task_path: Path,
        rollout_name: str | None,
        rollout_paths: Any,
        *,
        preserve_agent_network: bool,
        environment_manifest: Any,
    ) -> Any:
        # Copse calls the model from the worker host, so unlike an in-container
        # ACP CLI it never needs task-container egress for provider access.
        # Freeze the spike's safety condition even when an upstream task says
        # network_mode=public.
        del preserve_agent_network
        task.config.environment.network_mode = NetworkMode.NO_NETWORK
        task.config.environment.allowed_hosts = None
        task.config.environment.allow_internet = False
        return super().create_environment(
            environment,
            task,
            task_path,
            rollout_name,
            rollout_paths,
            preserve_agent_network=False,
            environment_manifest=environment_manifest,
        )

    async def install_agent(
        self,
        env: Any,
        agent: str,
        rollout_dir: Path,
        *,
        sandbox_setup_timeout: int = 120,
    ) -> AgentConfig:
        del env, agent, rollout_dir, sandbox_setup_timeout
        return AGENT_CONFIG

    async def write_credential_files(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def upload_subscription_auth(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def apply_web_tool_policy(self, *args: Any, **kwargs: Any) -> None:
        return None

    async def ensure_litellm_runtime(self, *args: Any, **kwargs: Any) -> Any:
        return dict(kwargs.get("agent_env") or {}), None

    async def stop_provider_runtime(self, runtime: Any) -> None:
        return None

    async def connect_acp(self, *args: Any, **kwargs: Any) -> Any:
        env = kwargs["env"]
        session = ACPSession(f"copse-{os.urandom(8).hex()}")
        skills = [] if self.profile == "skills-none" else await _load_skills(env)
        client = _CopseClient(
            env=env,
            session=session,
            agent_cwd=str(kwargs.get("agent_cwd") or "/app"),
            agent_env=dict(kwargs.get("agent_env") or {}),
            model=str(kwargs.get("model") or ""),
            bundle=self.bundle,
            profile=self.profile,
            skills=skills,
        )
        return client, session, _SessionAdapter(), "copse-skillsbench"

    async def execute_prompts(
        self,
        client: _CopseClient,
        session: ACPSession,
        prompts: list[str],
        timeout: int,
        *,
        idle_timeout: int | None = None,
    ) -> Any:
        del idle_timeout
        for prompt in prompts:
            session.record_user_prompt(prompt)
            if timeout > 0:
                self.last_result = await asyncio.wait_for(
                    _run_prompt(client, prompt), timeout=timeout
                )
            else:
                self.last_result = await _run_prompt(client, prompt)
            session.mark_prompt_end()
        return _capture_session_trajectory(session), len(session.tool_calls)
