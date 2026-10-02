from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from integrations.harbor.dock_agent import DockAgent, convert_dock_session, find_root_session


class DockAtifConversionTests(unittest.TestCase):
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
