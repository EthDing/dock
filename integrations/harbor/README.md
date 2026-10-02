# Harbor adapter

This integration runs Dock as a Harbor installed agent. Harbor installs the current local Git
`HEAD` in the task container, invokes Dock print mode, preserves Dock's native session JSONL, and
converts the root session to an ATIF `trajectory.json` for the Harbor viewer.

## Local development

Run Harbor from WSL with this repository on `PYTHONPATH`:

```bash
cd /mnt/e/dock
export PYTHONPATH="$PWD"
export OPENAI_API_KEY="..." # or the provider key selected by -m

harbor run \
  -d harbor/hello-world \
  -a integrations.harbor.dock_agent:DockAgent \
  -m openai/gpt-5 \
  --ak max_turns=100 \
  -n 1
```

Check installation without calling a model or running a verifier:

```bash
harbor run \
  -d harbor/hello-world \
  -a integrations.harbor.dock_agent:DockAgent \
  -m openai/gpt-5 \
  --install-only \
  -n 1
```

Useful adapter kwargs:

- `source_dir`: Dock Git working tree to archive; defaults to this repository.
- `archive_path`: prebuilt Linux `dock-linux.tar.gz`; skips pnpm install and build.
- `protocol`: Dock provider protocol override.
- `max_turns`: maximum Dock tool-use turns; defaults to 100.
- `no_memory`: disable Auto Memory for the trial; defaults to true.
- `permission_mode`: defaults to `bypassPermissions` inside Harbor's task container.
- `context_window` and `max_output_tokens`: optional Dock provider limits.
- `eval_skill_restore`: `none`, `full`, `head5k` (default), or `pointer`; sets
  `DOCK_EVAL_SKILL_RESTORE` in Dock.
- `eval_compact_after`: positive integer K; sets `DOCK_EVAL_COMPACT_AFTER` in Dock.
- `activate_skill`: prepend `Before starting, activate skill <name>.` to the instruction.

For example, add `--ak eval_skill_restore=pointer --ak eval_compact_after=5
--ak activate_skill=review` to compare restoration strategies. The named skill must already
be available in the task environment; this option only prepends the instruction.

The first successful skill activation starts the root session's counter. Its own tool result
does not count. Subsequent tool results (including errors) count individually; once K results
have completed, Dock compacts before the next model request, after the current batch finishes.
The trigger is attempted once per session, including across turns and restarts, and does not
apply to subagents. Normal automatic and manual compaction remain enabled. Invalid eval
values fail at startup. With no `DOCK_EVAL_COMPACT_AFTER`, there is no fixed trigger.

Restoration keeps the existing combined budget of approximately 25,000 tokens, newest skill
first. `full` removes only the per-skill cap; `head5k` includes the truncation notice in its
5,000-token cap; `pointer` keeps just the name, path and reload instruction; `none` adds no
skill attachment. A pointer or truncated skill can be reloaded through Skill or Read.
`compact_boundary.metadata.skillRestoration` contains `mode` and a `skills` array of
`{name, location, tokens}` (zero for omitted skills). Counts use Dock's characters/4 estimate.
A forced boundary also contains `evalCompactAfter`. The separate `eval_compaction_trigger`
record persists the attempt before summarization, including when summarization fails.

Credentials, agent `extra_env`, eval variables and instructions are uploaded in a temporary
0600 JSON file outside the logs, read inside the container, and removed before Dock starts
(with cleanup on failure). They are never passed through Harbor's exec environment or shell
arguments. Agent `extra_env` applies to the Dock process rather than installation commands.

Run adapter tests with Python 3.12+, Node.js 24+ and Harbor 0.22.0 installed:

```bash
python -m unittest discover -s integrations/harbor/tests -v
```

Without `archive_path`, the development installer uses `git archive HEAD` and builds Dock from
source in every fresh task container. Commit Dock runtime changes before testing them through the
adapter. For repeated trials, build one Linux release archive and pass it to every job:

```bash
--ak archive_path=/absolute/path/to/dock-linux.tar.gz
```

Each trial still extracts the archive into its clean container, but it does not restore pnpm
dependencies or compile Dock again. If the task image already has Node.js 24+, the adapter reuses it.

## Current limitations

- Linux task containers only.
- Root Dock session is converted; subagent sessions remain available as native JSONL but are not yet
  embedded as ATIF subagent trajectories.
- Token usage is preserved, but the adapter does not estimate monetary cost.
- The task container must allow network access during agent setup so Node.js and pnpm dependencies
  can be installed.
