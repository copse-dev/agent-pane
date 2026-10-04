"""Harbor agent that runs Copse's unattended container worker inside the task container.

Benchmark-only (docs/plans/thread-in-container.md, decision A20). Unlike
``copse_agent.py``, where the agent loop runs on the host and forwards shell calls,
the loop and its tools run *in* the Harbor task container, as they do in a Copse
"run a thread unattended in a container" run. Inference stays on the host: a Node
driver serves the worker's stdio egress link over ``docker compose exec -T`` and
calls LM Studio with credentials the container never holds.

Build the payload first: ``node scripts/build-harbor-container.mts`` (writes
``dist-test/harbor-container/``; override with ``COPSE_HARBOR_CONTAINER_DIR``).
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CONTAINER_DIR = "/opt/copse"
_NODE_IMAGE = "node:24-bookworm-slim"
_ARCH_PLATFORMS = {
    "x86_64": "amd64",
    "amd64": "amd64",
    "aarch64": "arm64",
    "arm64": "arm64",
}
# The worker stops itself 20 s before this; Harbor's own agent timeout still applies.
_DEFAULT_WALL_CLOCK_MS = 25 * 60_000


def _compose_project_name(session_id: str) -> str:
    """Harbor's own sanitisation (harbor/environments/docker/docker.py)."""
    name = session_id.lower()
    if not re.match(r"^[a-z0-9]", name):
        name = "0" + name
    return re.sub(r"[^a-z0-9_-]", "-", name)


async def _run(*argv: str, env: dict[str, str] | None = None) -> str:
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    stdout, _ = await process.communicate()
    output = stdout.decode("utf-8", errors="replace")
    if process.returncode != 0:
        raise RuntimeError(f"{' '.join(argv)} failed ({process.returncode}): {output}")
    return output


def _tuning_file(raw: str, scratch: Path) -> Path:
    """The benchmark tuning (``COPSE_HARBOR_TUNING``): a JSON object, or ``@path`` to a file
    holding one. Benchmark-only (benchmarks/terminal_bench/TUNING.md). Only the file path
    reaches the driver, which validates it against the strict schema in
    ``src/main/services/container-runtime/harbor-tuning.mts`` and fails the trial on any
    unknown key or bad value; this function only makes sure there is a file to hand over."""
    value = raw.strip()
    if value.startswith("@"):
        path = Path(value[1:]).expanduser()
        if not path.is_file():
            raise RuntimeError(f"COPSE_HARBOR_TUNING names {path}, which is not a file")
        return path
    json.loads(value)
    path = scratch / "tuning.requested.json"
    path.write_text(value)
    return path


class CopseContainerAgent(BaseAgent):
    """Run the product worker in the task container, inference on the host."""

    @staticmethod
    def name() -> str:
        return "copse-container"

    def version(self) -> str | None:
        return os.environ.get("COPSE_BENCH_AGENT_VERSION", "local")

    async def setup(self, environment: BaseEnvironment) -> None:
        del environment

    def _payload_dir(self) -> Path:
        configured = os.environ.get("COPSE_HARBOR_CONTAINER_DIR")
        payload = Path(configured) if configured else _REPO_ROOT / "dist-test" / "harbor-container"
        for required in ("worker.cjs", "driver.cjs", "node_modules"):
            if not (payload / required).exists():
                raise RuntimeError(
                    f"{payload / required} is missing; run `node scripts/build-harbor-container.mts`."
                )
        return payload

    async def _node_binary(self, platform: str) -> Path:
        """A linux Node 24 binary for the task's architecture, taken from the Node image
        (no download by hand; the image is the same one the product worker image is based on)."""
        cache = self._payload_dir().parent / f"node-linux-{platform}"
        if cache.is_file():
            return cache
        container = (
            await _run(
                "docker", "create", "--platform", f"linux/{platform}", _NODE_IMAGE
            )
        ).strip().splitlines()[-1]
        try:
            await _run("docker", "cp", f"{container}:/usr/local/bin/node", str(cache))
        finally:
            await _run("docker", "rm", container)
        cache.chmod(0o755)
        return cache

    def _exec_argv(self, environment: BaseEnvironment) -> tuple[list[str], dict[str, str]]:
        """argv for ``docker compose ... exec -T main`` on the trial's compose project, plus
        the environment compose needs to interpolate the project's files. Mirrors
        ``DockerEnvironment._run_docker_compose_command`` (private API; pinned Harbor 0.16.1)."""
        try:
            paths = getattr(environment, "_docker_compose_paths")
            compose_env = getattr(environment, "_compose_env_vars")(include_os_env=True)
            project_dir = Path(getattr(environment, "environment_dir")).resolve().absolute()
            session_id = getattr(environment, "session_id")
        except AttributeError as error:
            raise RuntimeError(
                "copse-container needs Harbor's Docker environment (--env docker)"
            ) from error
        argv = [
            "docker",
            "compose",
            "--project-name",
            _compose_project_name(session_id),
            "--project-directory",
            str(project_dir),
        ]
        for path in paths:
            argv.extend(["-f", str(Path(path).resolve().absolute())])
        argv.extend(["exec", "-T"])
        user = environment._resolve_user(None)  # type: ignore[attr-defined]
        if user is not None:
            argv.extend(["-u", str(user)])
        argv.append("main")
        return argv, dict(compose_env)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise RuntimeError("A model is required; pass --model or set LM_STUDIO_MODEL.")
        payload = self._payload_dir()
        self.logs_dir.mkdir(parents=True, exist_ok=True)

        uname = (await environment.exec("uname -m", timeout_sec=30)).stdout or ""
        platform = _ARCH_PLATFORMS.get(uname.strip())
        if platform is None:
            raise RuntimeError(f"Unsupported task architecture {uname.strip()!r}")
        node = await self._node_binary(platform)
        workspace = ((await environment.exec("pwd", timeout_sec=30)).stdout or "/app").strip() or "/app"

        await environment.exec(f"mkdir -p {_CONTAINER_DIR}", timeout_sec=60, user="root")
        await environment.upload_file(node, f"{_CONTAINER_DIR}/node")
        await environment.upload_file(payload / "worker.cjs", f"{_CONTAINER_DIR}/worker.cjs")
        await environment.upload_dir(payload / "node_modules", f"{_CONTAINER_DIR}/node_modules")
        await environment.exec(
            f"chmod -R a+rX {_CONTAINER_DIR} && chmod a+x {_CONTAINER_DIR}/node",
            timeout_sec=60,
            user="root",
        )

        exec_argv, compose_env = self._exec_argv(environment)
        wall_clock_ms = int(os.environ.get("COPSE_HARBOR_WALL_CLOCK_MS", str(_DEFAULT_WALL_CLOCK_MS)))
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as handle:
            handle.write(instruction)
            instruction_file = handle.name
        driver_args = [
            "node",
            str(payload / "driver.cjs"),
            "--exec-json",
            json.dumps(exec_argv),
            "--model",
            self.model_name.removeprefix("lmstudio:"),
            "--instruction-file",
            instruction_file,
            "--artifacts-dir",
            str(self.logs_dir),
            "--workspace",
            workspace,
            "--container-node",
            f"{_CONTAINER_DIR}/node",
            "--container-worker",
            f"{_CONTAINER_DIR}/worker.cjs",
            "--wall-clock-ms",
            str(wall_clock_ms),
        ]
        if os.environ.get("LM_STUDIO_URL"):
            driver_args.extend(["--lm-studio-url", os.environ["LM_STUDIO_URL"]])
        if os.environ.get("COPSE_HARBOR_MAX_STEPS"):
            driver_args.extend(["--max-steps", os.environ["COPSE_HARBOR_MAX_STEPS"]])
        if os.environ.get("COPSE_HARBOR_TUNING", "").strip():
            tuning_file = _tuning_file(os.environ["COPSE_HARBOR_TUNING"], self.logs_dir)
            driver_args.extend(["--tuning-file", str(tuning_file)])
        # Host-only credential: the driver reads it and drops it before it spawns anything.
        driver_env = {
            **os.environ,
            **compose_env,
            "LM_STUDIO_API_KEY": os.environ.get("LM_STUDIO_API_KEY", "lm-studio"),
        }
        process = await asyncio.create_subprocess_exec(
            *driver_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=driver_env,
        )
        try:
            stdout, stderr = await process.communicate()
        finally:
            if process.returncode is None:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=10)
                except TimeoutError:
                    process.kill()
                    await process.wait()
            Path(instruction_file).unlink(missing_ok=True)
        (self.logs_dir / "driver.stdout.log").write_bytes(stdout)
        (self.logs_dir / "driver.stderr.log").write_bytes(stderr)

        result_path = self.logs_dir / "out" / "result.json"
        context.metadata = {
            "harness": "copse-container",
            "driver_exit": process.returncode,
            "result": "out/result.json",
            "provider_requests": "provider-requests.jsonl",
            "model_parameters": "model-parameters.json",
            "step_timing": "step-timing.jsonl",
        }
        if not result_path.is_file():
            raise RuntimeError(
                f"copse-container produced no result.json (driver exit {process.returncode}):\n"
                + stderr.decode("utf-8", errors="replace")[-4000:]
            )
        result = json.loads(result_path.read_text())
        usage = result.get("usage", {})
        context.n_input_tokens = int(usage.get("inputTokens", 0))
        context.n_output_tokens = int(usage.get("outputTokens", 0))
        context.metadata.update(
            {
                "stop_reason": result.get("stopReason"),
                "prompts_attempted": result.get("promptsAttempted"),
                "deferrals": len(result.get("deferrals", [])),
                "denials": len(result.get("denials", [])),
                "containment": result.get("containment"),
            }
        )
        summary_path = self.logs_dir / "driver-summary.json"
        if summary_path.is_file():
            context.metadata["model_requests"] = json.loads(summary_path.read_text()).get(
                "modelCalls"
            )
