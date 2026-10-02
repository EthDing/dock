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
