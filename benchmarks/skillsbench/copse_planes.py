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


#: Every rollout in this spike runs with task-container egress off, whichever
#: plane stack it uses. Copse calls the model from the worker host, so unlike an
#: in-container ACP CLI it never needs egress for provider access. Applied even
#: when an upstream task declares ``network_mode=public``.
NETWORK_POLICY = "no-network"


def freeze_no_network(task: Any) -> None:
    """Pin the spike's network condition onto a task config, in place."""
    task.config.environment.network_mode = NetworkMode.NO_NETWORK
    task.config.environment.allowed_hosts = None
    task.config.environment.allow_internet = False


#: Inventory of what each upstream verifier fetches at grading time. 74 of the 87
#: v1.1 verifiers bootstrap their own test runner — `curl | sh` for `uv`, then
#: `uvx --with pytest==...`, or a bare `pip install`. Under the spike's
#: no-network run condition those fetches fail and the verifier scores 0 even
#: when the task's own `solve.sh` is correct: an oracle sweep measured 1 of 9
#: sampled tasks eligible, and the one that passed is among the 13 whose
#: verifier installs nothing at test time.
VERIFIER_DEPS_PATH = Path(__file__).with_name("verifier-deps.json")

#: Where the pre-warmed uv cache lives inside the task image.
UV_CACHE_DIR = "/opt/copse/uv-cache"


def _verifier_deps(task_name: str) -> dict[str, list[str]] | None:
    """Pinned test-time dependencies for one task, or None when it needs none."""
    try:
        doc = json.loads(VERIFIER_DEPS_PATH.read_text())
    except (OSError, ValueError):
        return None
    entry = doc.get("tasks", {}).get(task_name)
    return entry if isinstance(entry, dict) else None


def verifier_prebake_layer(task_name: str) -> str:
    """Dockerfile lines that pre-install a verifier's test-time dependencies.

    The image build has network; the rollout does not. Installing the pinned
    dependencies here lets the verifier's own bootstrap become a no-op at
    grading time — `apt-get install` finds the package already newest, `pip
    install` reports it already satisfied, the `curl | sh` fetch fails
    harmlessly (only 4 of the 45 uv verifiers use `set -e`), and `uvx --with`
    resolves out of the warmed cache under ``UV_OFFLINE``.

    Returns an empty string when the task's verifier fetches nothing, so
    self-contained tasks keep a byte-identical Dockerfile.
    """
    deps = _verifier_deps(task_name)
    if not deps:
        return ""
    lines = [
        "",
        "# --- copse skillsbench: pre-baked verifier test-time dependencies.",
        "# The verifier bootstraps its own runner from the network, which the",
        "# rollout forbids. Staged here, at build time, so grading works offline.",
    ]
    apt = deps.get("apt") or []
    if apt:
        lines.append(
            "RUN apt-get update && apt-get install -y --no-install-recommends "
            + " ".join(sorted(apt))
            + " && rm -rf /var/lib/apt/lists/*"
        )
    # `pipUnpinned` is upstream's own choice, not ours: some verifiers run a bare
    # `pip install pytest`. Installing the current version at build time still
    # makes the grading-time install report the requirement already satisfied,
    # which is all that is needed offline.
    pip = (deps.get("pip") or []) + (deps.get("pipUnpinned") or [])
    if pip:
        lines.append(
            "RUN pip3 install --break-system-packages --no-cache-dir "
            + " ".join(shlex.quote(p) for p in sorted(pip))
        )
    uv_versions = deps.get("uv") or []
    uvx_with = deps.get("uvxWith") or []
    if uv_versions:
        version = sorted(uv_versions)[0]
        lines.append(f"ENV UV_CACHE_DIR={UV_CACHE_DIR}")
        # Install to $HOME/.local/bin so the verifier's `source
        # $HOME/.local/bin/env` keeps working unchanged.
        lines.append(
            "RUN curl -LsSf https://astral.sh/uv/"
            + version
            + "/install.sh | sh"
        )
        if uvx_with:
            # Warm the cache by resolving the exact pins the verifier will ask
            # for. Done before UV_OFFLINE is set, so this step may use network.
            warm = " ".join(shlex.quote(p) for p in sorted(uvx_with))
            lines.append(
                'RUN . "$HOME/.local/bin/env" && uv venv /tmp/copse-warm '
                f"&& uv pip install --python /tmp/copse-warm/bin/python {warm} "
                "&& rm -rf /tmp/copse-warm"
            )
        # Only now pin offline, so the rollout cannot silently reach the network
        # even if the container's policy were ever relaxed by mistake.
        lines.append("ENV UV_OFFLINE=1")
    return "\n".join(lines) + "\n"


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
    checkpoints: list[dict[str, Any]] = []
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
            elif message.get("type") == "reasoning_checkpoint":
                record = message.get("record")
                if isinstance(record, dict):
                    checkpoints.append(record)
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
        final["reasoningCheckpoints"] = final.get("reasoningCheckpoints") or checkpoints
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


class _PrebakeVerifierDepsMixin:
    """Stage each verifier's test-time dependencies into the task image.

    Applied to both plane stacks: the oracle only calibrates the agent trials if
    it grades under the same image and the same network condition.
    """

    #: Marker that makes the append idempotent across trials on one worker.
    PREBAKE_MARKER = "copse skillsbench: pre-baked verifier"

    def prebake_verifier_deps(self, task_path: Path) -> bool:
        """Append the pre-bake layer to a task's Dockerfile. Returns whether it did.

        Called from ``create_environment`` rather than ``stage_dockerfile_deps``:
        BenchFlow only invokes the latter when ``RolloutConfig.context_root`` is
        set, which this spike never sets, so hooking it silently did nothing.
        ``create_environment`` runs unconditionally for every rollout.
        """
        layer = verifier_prebake_layer(task_path.name)
        if not layer:
            return False
        dockerfile = task_path / "environment" / "Dockerfile"
        if not dockerfile.is_file():
            return False
        existing = dockerfile.read_text()
        if self.PREBAKE_MARKER in existing:
            return False
        separator = "" if existing.endswith("\n") else "\n"
        dockerfile.write_text(existing + separator + layer)
        return True

    def stage_dockerfile_deps(self, task_path: Path, context_root: Path) -> None:
        # Kept for the context_root case; the append is guarded, so whichever
        # hook fires first wins and the other is a no-op.
        super().stage_dockerfile_deps(task_path, context_root)  # type: ignore[misc]
        self.prebake_verifier_deps(task_path)


class CopseRolloutPlanes(_PrebakeVerifierDepsMixin, DefaultRolloutPlanes):
    def __init__(self, *, bundle: Path, profile: str) -> None:
        super().__init__()
        self.bundle = bundle
        self.profile = profile
        self.base_profile = profile.split("@", 1)[0]
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
        del preserve_agent_network
        self.prebake_verifier_deps(task_path)
        freeze_no_network(task)
        return super().create_environment(
            environment,
            task,
            task_path,
            rollout_name,
            rollout_paths,
            preserve_agent_network=False,
            environment_manifest=environment_manifest,
        )



class OracleRolloutPlanes(_PrebakeVerifierDepsMixin, DefaultRolloutPlanes):
    """Stock planes with only the spike's network condition applied.

    The oracle runs the task's own ``solve.sh`` through BenchFlow's normal agent
    plane, so none of the Copse overrides above apply to it. It must still see
    the *same* environment the agent trials saw, or it is not a control for
    them: an oracle with egress calibrates nothing about trials without it.
    """

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
        del preserve_agent_network
        self.prebake_verifier_deps(task_path)
        freeze_no_network(task)
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
        skills = [] if self.base_profile == "skills-none" else await _load_skills(env)
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
