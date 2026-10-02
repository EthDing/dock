"""Harbor installed-agent adapter for Dock.

The adapter deliberately lives outside Dock's TypeScript runtime. Dock remains a
normal CLI agent; Harbor installs it into the task container, invokes print mode,
and converts Dock's persisted session JSONL into ATIF after the run.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json


_PROVIDER_PROTOCOLS = {
    "anthropic": "anthropic-messages",
    "deepseek": "openai-responses",
    "openai": "openai-responses",
}

_PROVIDER_API_KEY_ENVS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
}


class DockAgent(BaseInstalledAgent):
    """Run the local Dock source tree as a Harbor installed agent."""

    SUPPORTS_ATIF = True
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    def __init__(
        self,
        *args: Any,
        source_dir: str | Path | None = None,
        archive_path: str | Path | None = None,
        protocol: str | None = None,
        max_turns: int = 100,
        no_memory: bool = True,
        permission_mode: str = "bypassPermissions",
        context_window: int | None = None,
        max_output_tokens: int | None = None,
        eval_skill_restore: str | None = None,
        eval_compact_after: int | None = None,
        activate_skill: str | None = None,
        node_version: str = "24",
        pnpm_version: str = "10.34.5",
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._source_dir = (
            Path(source_dir).expanduser().resolve()
            if source_dir is not None
            else Path(__file__).resolve().parents[2]
        )
        self._archive_path = (
            Path(archive_path).expanduser().resolve() if archive_path is not None else None
        )
        self._protocol = protocol
        self._max_turns = max_turns
        self._no_memory = no_memory
        self._permission_mode = permission_mode
        self._context_window = context_window
        self._max_output_tokens = max_output_tokens
        if eval_skill_restore not in {None, "none", "full", "head5k", "pointer"}:
            raise ValueError("eval_skill_restore must be none, full, head5k, or pointer")
        if eval_compact_after is not None and (
            isinstance(eval_compact_after, bool)
            or not isinstance(eval_compact_after, int)
            or not 0 < eval_compact_after <= 2**53 - 1
        ):
            raise ValueError("eval_compact_after must be a positive safe integer")
        if activate_skill is not None and (
            not isinstance(activate_skill, str)
            or not activate_skill.strip()
            or "\n" in activate_skill
            or "\r" in activate_skill
        ):
            raise ValueError("activate_skill must be a nonempty single-line Skill name")
        self._eval_skill_restore = eval_skill_restore
        self._eval_compact_after = eval_compact_after
        self._activate_skill = activate_skill
        self._node_version = node_version
        self._pnpm_version = pnpm_version

        if not self.model_name:
            raise ValueError("DockAgent requires a model name")
        if max_turns <= 0:
            raise ValueError("max_turns must be positive")
        if self._archive_path is not None and not self._archive_path.is_file():
            raise FileNotFoundError(f"Dock release archive not found: {self._archive_path}")
        if self._archive_path is None and not (self._source_dir / "package.json").is_file():
            raise FileNotFoundError(
                f"Dock source directory does not contain package.json: {self._source_dir}"
            )

    @staticmethod
    def name() -> str:
        return "dock"

    @property
    def extra_env(self) -> dict[str, str]:
        # Trial otherwise injects these through Docker exec arguments. Preserve
        # them in the private payload instead, including custom provider keys.
        return {}

    def get_version_command(self) -> str | None:
        return "dock --version"

    async def install(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(
            environment,
            ("bash", "curl", "git", "ripgrep", "ca_certificates", "tar"),
        )

        if self._archive_path is not None:
            await environment.upload_file(self._archive_path, "/tmp/dock-release.tar.gz")
        else:
            with tempfile.TemporaryDirectory(prefix="dock-harbor-source-") as temp_dir:
                archive = Path(temp_dir) / "dock-source.tar.gz"
                subprocess.run(
                    [
                        "git",
                        "-C",
                        str(self._source_dir),
                        "archive",
                        "--format=tar.gz",
                        f"--output={archive}",
                        "HEAD",
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                )
                await environment.upload_file(archive, "/tmp/dock-source.tar.gz")

        node_setup = f"""
set -euo pipefail
if command -v node >/dev/null 2>&1 && [ "$(node -p 'Number(process.versions.node.split(\".\")[0])')" -ge 24 ]; then
  :
else
  export NVM_DIR=/opt/dock-nvm
  mkdir -p "$NVM_DIR"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    PROFILE=/dev/null curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash
  fi
  . "$NVM_DIR/nvm.sh"
  nvm install {shlex.quote(self._node_version)}
  nvm alias default {shlex.quote(self._node_version)}
fi
for bin in node npm npx; do
  target=$(command -v "$bin")
  if [ "$target" != "/usr/local/bin/$bin" ]; then
    ln -sfn "$target" "/usr/local/bin/$bin"
  fi
done
"""
        if self._archive_path is not None:
            dock_setup = """
rm -rf /opt/dock
mkdir -p /opt/dock
tar -xzf /tmp/dock-release.tar.gz -C /opt/dock
"""
        else:
            dock_setup = f"""
npm install --global pnpm@{shlex.quote(self._pnpm_version)}
ln -sfn "$(command -v pnpm)" /usr/local/bin/pnpm
rm -rf /opt/dock
mkdir -p /opt/dock
tar -xzf /tmp/dock-source.tar.gz -C /opt/dock
cd /opt/dock
CI=1 pnpm install --frozen-lockfile
pnpm build
"""
        install_command = f"""
{node_setup}
{dock_setup}
chmod +x /opt/dock/dist/cli.js
ln -sfn /opt/dock/dist/cli.js /usr/local/bin/dock
dock --version
"""
        await self.exec_as_root(environment, command=install_command, timeout_sec=600)

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context  # Populated from the persisted session after the run.
        settings, dock_model, run_env = self._runtime_settings()
        if self._activate_skill is not None:
            instruction = f"Before starting, activate skill {self._activate_skill}.\n\n{instruction}"
        # Harbor's Docker backend may serialize exec env into process arguments.
        # Upload credentials privately and load them only inside the container.
        remote_payload = f"/tmp/dock-harbor-run-{uuid.uuid4().hex}.json"
        runner = """
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const payloadPath = process.argv[1];
const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
fs.unlinkSync(payloadPath);
const home = process.env.HOME;
const configDir = path.join(home, '.dock');
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  path.join(configDir, 'settings.json'),
  JSON.stringify(payload.settings, null, 2) + '\\n',
  { mode: 0o600 },
);
fs.writeFileSync(
  path.join(configDir, 'trusted-workspaces.json'),
  JSON.stringify({ workspaces: [process.cwd()] }, null, 2) + '\\n',
  { mode: 0o600 },
);
const result = spawnSync('dock', payload.flags, {
  env: { ...process.env, ...payload.env },
  input: payload.instruction,
  stdio: ['pipe', 'inherit', 'inherit'],
});
process.exit(result.status ?? 1);
"""

        log_dir = self.environment_logs_dir.as_posix()
        flags = [
            "--print",
            "--model",
            dock_model,
            "--permission-mode",
            self._permission_mode,
            "--max-turns",
            str(self._max_turns),
            "--output-format",
            "stream-json",
        ]
        if self._no_memory:
            flags.append("--no-memory")
        command = (
            f"mkdir -p {shlex.quote(log_dir)} && "
            f"node -e {shlex.quote(runner)} {shlex.quote(remote_payload)} "
            f"2> >(tee {shlex.quote(log_dir + '/dock-stderr.txt')} >&2) "
            f"| tee {shlex.quote(log_dir + '/dock-stream.jsonl')}"
        )
        try:
            with tempfile.TemporaryDirectory(prefix="dock-harbor-run-") as temp_dir:
                payload_path = Path(temp_dir) / "run.json"
                descriptor = os.open(payload_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as payload:
                    json.dump(
                        {"settings": settings, "env": run_env,
                         "instruction": instruction, "flags": flags},
                        payload,
                    )
                await environment.upload_file(payload_path, remote_payload)
            owner = environment.default_user
            permissions = f"chmod 600 {shlex.quote(remote_payload)}"
            if owner is not None:
                permissions += f" && chown {shlex.quote(str(owner))} {shlex.quote(remote_payload)}"
            await self.exec_as_root(environment, command=permissions)
            await self.exec_as_agent(
                environment,
                command=command,
            )
        finally:
            await self.exec_as_root(environment, command=f"rm -f {shlex.quote(remote_payload)}")
            await self.exec_as_agent(
                environment,
                command=(
                    f"rm -rf {shlex.quote(log_dir + '/sessions')} && "
                    'if [ -d "$HOME/.dock/projects" ]; then '
                    f"cp -R \"$HOME/.dock/projects\" {shlex.quote(log_dir + '/sessions')}; "
                    "fi"
                ),
            )

    def populate_context_post_run(self, context: AgentContext) -> None:
        session_path = find_root_session(self.logs_dir / "sessions")
        if session_path is None:
            self.logger.warning("Dock did not produce a root session JSONL file")
            return
        trajectory = convert_dock_session(
            session_path,
            model_name=self.model_name,
            agent_version=self.version() or "unknown",
        )
        trajectory_path = self.logs_dir / "trajectory.json"
        trajectory_path.write_text(
            format_trajectory_json(trajectory.to_json_dict()),
            encoding="utf-8",
        )
        if trajectory.final_metrics:
            context.n_input_tokens = trajectory.final_metrics.total_prompt_tokens
            context.n_cache_tokens = trajectory.final_metrics.total_cached_tokens
            context.n_output_tokens = trajectory.final_metrics.total_completion_tokens
            context.cost_usd = trajectory.final_metrics.total_cost_usd

    def _runtime_settings(self) -> tuple[dict[str, Any], str, dict[str, str]]:
        model_name = self.model_name or ""
        connection = self.model_connection
        provider = connection.provider
        if not provider and "/" in model_name:
            provider = model_name.split("/", 1)[0]
        provider = provider or "openai"
        model_id = model_name.split("/", 1)[-1]
        dock_model = f"{provider}:{model_id}"
        protocol = self._protocol or _PROVIDER_PROTOCOLS.get(
            provider, "openai-chat-completions"
        )
        api_key_env = _PROVIDER_API_KEY_ENVS.get(provider)
        if api_key_env is None:
            api_key_env = next(
                (key for key in connection.env if "KEY" in key or "TOKEN" in key),
                f"{provider.upper().replace('-', '_')}_API_KEY",
            )

        provider_settings: dict[str, Any] = {
            "protocol": protocol,
            "apiKeyEnv": api_key_env,
        }
        if connection.base_url:
            provider_settings["baseUrl"] = connection.base_url
        if self._context_window is not None:
            provider_settings["contextWindow"] = self._context_window
        if self._max_output_tokens is not None:
            provider_settings["maxOutputTokens"] = self._max_output_tokens

        settings = {
            "model": dock_model,
            "providers": {provider: provider_settings},
            "permissions": {"defaultMode": self._permission_mode},
            "sandbox": {"enabled": False},
            "autoMemoryEnabled": not self._no_memory,
            "subagents": {"backgroundEnabled": False},
        }
        run_env = {**self._extra_env, **connection.env}
        if self._eval_skill_restore is not None:
            run_env["DOCK_EVAL_SKILL_RESTORE"] = self._eval_skill_restore
        if self._eval_compact_after is not None:
            run_env["DOCK_EVAL_COMPACT_AFTER"] = str(self._eval_compact_after)
        return settings, dock_model, run_env


def find_root_session(root: Path) -> Path | None:
    if not root.exists():
        return None
    candidates: list[Path] = []
    for path in root.rglob("*.jsonl"):
        records = _read_records(path)
        first = records[0] if records else None
        if (
            isinstance(first, dict)
            and first.get("type") == "session_start"
            and not first.get("agentId")
        ):
            candidates.append(path)
    return max(candidates, key=lambda path: path.stat().st_mtime) if candidates else None


def convert_dock_session(
    session_path: Path,
    *,
    model_name: str | None,
    agent_version: str,
) -> Trajectory:
    records = _read_records(session_path)
    if not records:
        raise ValueError(f"Dock session is empty: {session_path}")
    metadata = records[0]
    session_id = str(metadata.get("sessionId") or session_path.stem)

    steps: list[Step] = []
    tool_steps: dict[str, int] = {}
    total_prompt = 0
    total_completion = 0
    total_cached = 0
    total_cache_creation = 0

    for record in records:
        record_type = record.get("type")
        if record_type not in {"user", "assistant"}:
            continue
        message = record.get("message")
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        timestamp = record.get("timestamp")

        if record_type == "assistant":
            text = _join_blocks(content, "text", "text")
            reasoning = _join_blocks(content, "thinking", "thinking") or None
            tool_calls: list[ToolCall] = []
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                call_id = str(block.get("id") or "")
                if not call_id:
                    continue
                arguments = block.get("input")
                tool_calls.append(
                    ToolCall(
                        tool_call_id=call_id,
                        function_name=str(block.get("name") or ""),
                        arguments=arguments if isinstance(arguments, dict) else {},
                    )
                )

            usage = message.get("usage")
            metrics = _metrics_from_usage(usage)
            if isinstance(usage, dict):
                total_prompt += _int(usage.get("inputTokens"))
                total_completion += _int(usage.get("outputTokens"))
                total_cached += _int(usage.get("cacheReadInputTokens"))
                total_cache_creation += _int(usage.get("cacheCreationInputTokens"))

            step = Step(
                step_id=len(steps) + 1,
                timestamp=timestamp if isinstance(timestamp, str) else None,
                source="agent",
                model_name=model_name,
                message=text,
                reasoning_content=reasoning,
                tool_calls=tool_calls or None,
                metrics=metrics,
                llm_call_count=1,
            )
            steps.append(step)
            for call in tool_calls:
                tool_steps[call.tool_call_id] = len(steps) - 1
            continue

        text = _join_blocks(content, "text", "text")
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            call_id = str(block.get("toolUseId") or "")
            step_index = tool_steps.get(call_id)
            if step_index is None:
                continue
            step = steps[step_index]
            existing = step.observation.results if step.observation else []
            step.observation = Observation(
                results=[
                    *existing,
                    ObservationResult(
                        source_call_id=call_id,
                        content=str(block.get("content") or ""),
                        extra={"is_error": bool(block.get("isError", False))},
                    ),
                ]
            )
        if text:
            steps.append(
                Step(
                    step_id=len(steps) + 1,
                    timestamp=timestamp if isinstance(timestamp, str) else None,
                    source="user",
                    message=text,
                    extra={
                        key: True
                        for key in ("isMeta", "isCompactSummary")
                        if record.get(key) is True
                    }
                    or None,
                )
            )

    if not steps:
        raise ValueError(f"Dock session contains no messages: {session_path}")

    return Trajectory(
        schema_version="ATIF-v1.7",
        session_id=session_id,
        agent=Agent(
            name="dock",
            version=agent_version,
            model_name=model_name,
            extra={
                "source_format": "dock-session-v1",
                "cwd": metadata.get("cwd"),
            },
        ),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=total_prompt or None,
            total_completion_tokens=total_completion or None,
            total_cached_tokens=total_cached or None,
            total_steps=len(steps),
            extra={"total_cache_creation_input_tokens": total_cache_creation},
        ),
    )


def _read_records(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def _join_blocks(content: list[Any], block_type: str, field: str) -> str:
    return "\n".join(
        str(block.get(field) or "")
        for block in content
        if isinstance(block, dict) and block.get("type") == block_type and block.get(field)
    )


def _metrics_from_usage(value: Any) -> Metrics | None:
    if not isinstance(value, dict):
        return None
    prompt = _int(value.get("inputTokens"))
    completion = _int(value.get("outputTokens"))
    cached = _int(value.get("cacheReadInputTokens"))
    creation = _int(value.get("cacheCreationInputTokens"))
    if not any((prompt, completion, cached, creation)):
        return None
    return Metrics(
        prompt_tokens=prompt or None,
        completion_tokens=completion or None,
        cached_tokens=cached or None,
        extra={"cache_creation_input_tokens": creation} if creation else None,
    )


def _int(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0
