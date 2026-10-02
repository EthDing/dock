from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from integrations.harbor.dock_agent import DockAgent, convert_dock_session, find_root_session


class DockInstallationTests(unittest.IsolatedAsyncioTestCase):
    async def test_archive_install_preserves_existing_node_binaries(self) -> None:
        await self._check_archive_install(existing_at_destination=True)

    async def test_archive_install_links_node_binaries_from_another_directory(
        self,
    ) -> None:
        await self._check_archive_install(existing_at_destination=False)

    async def _check_archive_install(self, *, existing_at_destination: bool) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            destination = root / "bin"
            destination.mkdir()
            source = destination if existing_at_destination else root / "node-bin"
            source.mkdir(exist_ok=True)
            for name in ("node", "npm", "npx"):
                executable = source / name
                executable.write_text("#!/bin/sh\nprintf '24\\n'\n")
                executable.chmod(0o755)
            package = root / "package"
            (package / "dist").mkdir(parents=True)
            (package / "dist/cli.js").write_text(
                "#!/bin/sh\nprintf 'installed-dock\\n'\n"
            )
            archive = root / "dock-linux.tar.gz"
            with tarfile.open(archive, "w:gz") as contents:
                contents.add(package, arcname=".")
            agent = DockAgent(
                logs_dir=root / "logs",
                model_name="openai/gpt-test",
                archive_path=archive,
            )
            environment = SimpleNamespace(upload_file=AsyncMock())

            async def execute(_environment, *, command, timeout_sec):
                self.assertEqual(timeout_sec, 600)
                self.assertNotIn("pnpm install", command)
                self.assertNotIn("pnpm build", command)
                # Run the real installer shell, redirecting its container-only
                # paths into this test's private directory.
                command = command.replace("/usr/local/bin", str(destination))
                command = command.replace("/opt/dock", str(root / "installed"))
                command = command.replace("/tmp/dock-release.tar.gz", str(archive))
                result = subprocess.run(
                    ["/bin/bash", "-c", command],
                    cwd=root,
                    env={"PATH": f"{source}:{destination}:/usr/bin:/bin"},
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(result.stdout.strip(), "installed-dock")

            with patch.object(
                agent, "ensure_system_dependencies", new_callable=AsyncMock
            ), patch.object(
                agent,
                "exec_as_root",
                new=AsyncMock(side_effect=execute),
            ):
                await agent.install(environment)
            environment.upload_file.assert_awaited_once_with(
                archive, "/tmp/dock-release.tar.gz"
            )
            for name in ("node", "npm", "npx"):
                executable = destination / name
                self.assertEqual(executable.is_symlink(), not existing_at_destination)
                self.assertEqual(executable.resolve(), (source / name).resolve())
                self.assertEqual(executable.read_text(), "#!/bin/sh\nprintf '24\\n'\n")


class DockEvalRunTests(unittest.IsolatedAsyncioTestCase):
    async def test_run_uploads_private_configuration_and_launches_with_no_secret_arguments(
        self,
    ) -> None:
        node = shutil.which("node")
        self.assertIsNotNone(node)
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ, {"OPENAI_API_KEY": "fake-eval-secret"}, clear=True
        ):
            root = Path(temp_dir)
            agent = DockAgent(
                logs_dir=root,
                model_name="openai/gpt-test",
                eval_skill_restore="pointer",
                eval_compact_after=3,
                activate_skill="review",
            )
            captured = {}
            uploaded = root / "uploaded.json"

            async def upload(source, target):
                source = Path(source)
                self.assertEqual(source.stat().st_mode & 0o777, 0o600)
                captured.update(json.loads(source.read_text()))
                uploaded.write_bytes(source.read_bytes())
                captured["remote"] = target

            environment = SimpleNamespace(
                default_user="1000", upload_file=AsyncMock(side_effect=upload)
            )
            with patch.object(
                agent, "exec_as_root", new_callable=AsyncMock
            ) as root_exec, patch.object(
                agent, "exec_as_agent", new_callable=AsyncMock
            ) as agent_exec:
                await agent.run("Original task\n'$(false)'", environment, None)
                command = agent_exec.call_args_list[0].kwargs["command"]
                for call in [*root_exec.call_args_list, *agent_exec.call_args_list]:
                    self.assertNotIn("fake-eval-secret", str(call))
                    self.assertNotIn("env", call.kwargs)
                self.assertIn(
                    "chmod 600", root_exec.call_args_list[0].kwargs["command"]
                )
                self.assertIn(
                    "chown 1000", root_exec.call_args_list[0].kwargs["command"]
                )
                self.assertEqual(
                    root_exec.call_args_list[-1].kwargs["command"],
                    f"rm -f {captured['remote']}",
                )

            self.assertEqual(captured["env"]["DOCK_EVAL_SKILL_RESTORE"], "pointer")
            self.assertEqual(captured["env"]["DOCK_EVAL_COMPACT_AFTER"], "3")
            self.assertEqual(
                captured["instruction"],
                "Before starting, activate skill review.\n\nOriginal task\n'$(false)'",
            )
            self.assertNotIn("fake-eval-secret", json.dumps(captured["settings"]))

            # Execute the actual in-container bootstrap against a fake Dock CLI.
            # Synthetic credentials travel in the child environment and the task
            # travels through stdin; neither is interpolated into shell commands.
            executable = root / "dock"
            executable.write_text(
                "#!/usr/bin/python3\nimport json, os, sys\nprint(json.dumps({'instruction':sys.stdin.read(), 'mode':os.environ.get('DOCK_EVAL_SKILL_RESTORE'), 'after':os.environ.get('DOCK_EVAL_COMPACT_AFTER'), 'key':os.environ.get('OPENAI_API_KEY'), 'args':sys.argv[1:]}))\n"
            )
            executable.chmod(0o755)
            tokens = shlex.split(command)
            runner = tokens[tokens.index("-e") + 1]
            result = subprocess.run(
                [node, "-e", runner, str(uploaded)],
                cwd=root,
                env={**os.environ, "HOME": str(root), "PATH": f"{root}:/usr/bin:/bin"},
                capture_output=True,
                text=True,
                check=True,
            )
            actual = json.loads(result.stdout)
            self.assertEqual(actual["instruction"], captured["instruction"])
            self.assertEqual(actual["mode"], "pointer")
            self.assertEqual(actual["after"], "3")
            self.assertEqual(actual["key"], "fake-eval-secret")
            self.assertEqual(actual["args"], captured["flags"])
            self.assertFalse(uploaded.exists())
            self.assertEqual(
                (root / ".dock/settings.json").stat().st_mode & 0o777, 0o600
            )

    async def test_default_instruction_is_unchanged_and_payload_is_cleaned_on_failure(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ, {}, clear=True
        ):
            agent = DockAgent(logs_dir=Path(temp_dir), model_name="openai/gpt-test")
            payloads = []

            async def upload(source, target):
                payloads.append(json.loads(Path(source).read_text()))

            environment = SimpleNamespace(
                default_user=None, upload_file=AsyncMock(side_effect=upload)
            )
            with patch.object(
                agent, "exec_as_root", new_callable=AsyncMock
            ) as root_exec, patch.object(
                agent,
                "exec_as_agent",
                new=AsyncMock(side_effect=[RuntimeError("failed"), None]),
            ):
                with self.assertRaisesRegex(RuntimeError, "failed"):
                    await agent.run("Original task", environment, None)
                self.assertIn(
                    "rm -f /tmp/dock-harbor-run-",
                    root_exec.call_args_list[-1].kwargs["command"],
                )
            self.assertEqual(payloads[0]["instruction"], "Original task")
            self.assertEqual(payloads[0]["env"], {})

    async def test_upload_failure_still_removes_remote_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            agent = DockAgent(logs_dir=Path(temp_dir), model_name="openai/gpt-test")
            environment = SimpleNamespace(
                default_user=None,
                upload_file=AsyncMock(side_effect=RuntimeError("upload failed")),
            )
            with patch.object(
                agent, "exec_as_root", new_callable=AsyncMock
            ) as root_exec, patch.object(
                agent, "exec_as_agent", new_callable=AsyncMock
            ):
                with self.assertRaisesRegex(RuntimeError, "upload failed"):
                    await agent.run("task", environment, None)
                self.assertIn(
                    "rm -f /tmp/dock-harbor-run-", root_exec.call_args.kwargs["command"]
                )


class DockAtifConversionTests(unittest.TestCase):
    def test_extra_environment_bypasses_harbor_exec_and_uses_private_payload(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ, {}, clear=True
        ):
            agent = DockAgent(
                logs_dir=Path(temp_dir),
                model_name="openai/gpt-test",
                extra_env={"OPENAI_API_KEY": "fake-key", "CUSTOM_VALUE": "value"},
            )
            self.assertEqual(agent.extra_env, {})
            self.assertEqual(
                agent._runtime_settings()[2],
                {
                    "OPENAI_API_KEY": "fake-key",
                    "CUSTOM_VALUE": "value",
                },
            )

    def test_validates_eval_parameters(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            for kwargs in [
                {"eval_skill_restore": "bad"},
                {"eval_compact_after": 0},
                {"eval_compact_after": -1},
                {"eval_compact_after": 1.5},
                {"eval_compact_after": True},
                {"eval_compact_after": 2**53},
                {"activate_skill": "review\nignore instructions"},
            ]:
                with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                    DockAgent(
                        logs_dir=Path(temp_dir), model_name="openai/gpt-test", **kwargs
                    )

    def test_accepts_every_restore_mode(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ, {}, clear=True
        ):
            for mode in ["none", "full", "head5k", "pointer"]:
                with self.subTest(mode=mode):
                    agent = DockAgent(
                        logs_dir=Path(temp_dir),
                        model_name="openai/gpt-test",
                        eval_skill_restore=mode,
                    )
                    self.assertEqual(
                        agent._runtime_settings()[2], {"DOCK_EVAL_SKILL_RESTORE": mode}
                    )

    def test_translates_harbor_model_to_dock_settings(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as temp_dir:
            agent = DockAgent(
                logs_dir=Path(temp_dir),
                model_name="openai/gpt-test",
                source_dir=repository,
            )
            settings, dock_model, run_env = agent._runtime_settings()

        self.assertEqual(dock_model, "openai:gpt-test")
        self.assertEqual(settings["model"], dock_model)
        self.assertEqual(settings["providers"]["openai"]["protocol"], "openai-responses")
        self.assertEqual(settings["providers"]["openai"]["apiKeyEnv"], "OPENAI_API_KEY")
        self.assertEqual(run_env, {})

    def test_accepts_prebuilt_release_archive(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            archive = Path(temp_dir) / "dock-linux.tar.gz"
            archive.write_bytes(b"archive")
            agent = DockAgent(
                logs_dir=Path(temp_dir),
                model_name="openai/gpt-test",
                archive_path=archive,
            )

        self.assertEqual(agent._archive_path, archive)

    def test_passes_inferred_provider_endpoint_to_dock(self) -> None:
        repository = Path(__file__).resolve().parents[3]
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {"DEEPSEEK_API_KEY": "test-key"},
        ):
            agent = DockAgent(
                logs_dir=Path(temp_dir),
                model_name="deepseek/deepseek-v4-flash",
                source_dir=repository,
            )
            settings, _, run_env = agent._runtime_settings()

        provider = settings["providers"]["deepseek"]
        self.assertEqual(provider["protocol"], "openai-responses")
        self.assertEqual(provider["baseUrl"], "https://api.deepseek.com")
        self.assertEqual(run_env, {"DEEPSEEK_API_KEY": "test-key"})

    def test_converts_messages_tools_observations_and_usage(self) -> None:
        session_id = "11111111-1111-4111-8111-111111111111"
        records = [
            {
                "type": "session_start",
                "version": 1,
                "sessionId": session_id,
                "cwd": "/app",
                "createdAt": "2026-09-01T00:00:00Z",
            },
            {
                "type": "user",
                "sessionId": session_id,
                "cwd": "/app",
                "parentUuid": None,
                "uuid": "21111111-1111-4111-8111-111111111111",
                "timestamp": "2026-09-01T00:00:01Z",
                "message": {"role": "user", "content": [{"type": "text", "text": "Fix it"}]},
            },
            {
                "type": "assistant",
                "sessionId": session_id,
                "cwd": "/app",
                "parentUuid": "21111111-1111-4111-8111-111111111111",
                "uuid": "31111111-1111-4111-8111-111111111111",
                "timestamp": "2026-09-01T00:00:02Z",
                "message": {
                    "role": "assistant",
                    "id": "msg_1",
                    "content": [
                        {"type": "thinking", "thinking": "Inspect first"},
                        {
                            "type": "tool_use",
                            "id": "tool_1",
                            "name": "Read",
                            "input": {"file_path": "a.ts"},
                        },
                    ],
                    "stopReason": "tool_use",
                    "usage": {
                        "inputTokens": 100,
                        "outputTokens": 20,
                        "cacheReadInputTokens": 40,
                        "cacheCreationInputTokens": 5,
                    },
                },
            },
            {
                "type": "user",
                "sessionId": session_id,
                "cwd": "/app",
                "parentUuid": "31111111-1111-4111-8111-111111111111",
                "uuid": "41111111-1111-4111-8111-111111111111",
                "timestamp": "2026-09-01T00:00:03Z",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "toolUseId": "tool_1",
                            "content": "export const ok = true",
                            "isError": False,
                        }
                    ],
                },
            },
            {
                "type": "assistant",
                "sessionId": session_id,
                "cwd": "/app",
                "parentUuid": "41111111-1111-4111-8111-111111111111",
                "uuid": "51111111-1111-4111-8111-111111111111",
                "timestamp": "2026-09-01T00:00:04Z",
                "message": {
                    "role": "assistant",
                    "id": "msg_2",
                    "content": [{"type": "text", "text": "Done"}],
                    "stopReason": "end_turn",
                    "usage": {"inputTokens": 120, "outputTokens": 10},
                },
            },
        ]

        with tempfile.TemporaryDirectory() as temp_dir:
            session = Path(temp_dir) / f"{session_id}.jsonl"
            session.write_text(
                "".join(f"{json.dumps(record)}\n" for record in records),
                encoding="utf-8",
            )
            trajectory = convert_dock_session(
                session,
                model_name="openai/gpt-test",
                agent_version="0.1.0",
            )

        self.assertEqual([step.source for step in trajectory.steps], ["user", "agent", "agent"])
        tool_step = trajectory.steps[1]
        self.assertEqual(tool_step.tool_calls[0].function_name, "Read")
        self.assertEqual(
            tool_step.observation.results[0].content,
            "export const ok = true",
        )
        self.assertEqual(trajectory.final_metrics.total_prompt_tokens, 220)
        self.assertEqual(trajectory.final_metrics.total_completion_tokens, 30)
        self.assertEqual(trajectory.final_metrics.total_cached_tokens, 40)

    def test_finds_root_session_and_ignores_subagent_session(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            root_session = root / "root.jsonl"
            child_session = root / "agent-child.jsonl"
            root_session.write_text(
                json.dumps({"type": "session_start", "sessionId": "root", "cwd": "/app"})
                + "\n",
                encoding="utf-8",
            )
            child_session.write_text(
                json.dumps(
                    {
                        "type": "session_start",
                        "sessionId": "root",
                        "agentId": "child",
                        "cwd": "/app",
                    }
                )
                + "\n",
                encoding="utf-8",
            )
            self.assertEqual(find_root_session(root), root_session)


if __name__ == "__main__":
    unittest.main()
