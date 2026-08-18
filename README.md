# Dock

Dock is a Linux-first TypeScript coding-agent harness that reproduces the stable, documented
Claude Code product flow while using a fork of `pi-tui` for its terminal interface.

## Development

Run all project commands inside WSL:

```bash
cd <repository>
pnpm install
pnpm run ci
```

Maintainers and coding agents should start with the focused design notes in
[`docs/internals/`](docs/internals/README.md) before changing a core subsystem.

## First run

Build and start Dock inside WSL:

```bash
pnpm build
node dist/cli.js
```

If no model is configured, Dock opens a first-run setup flow before the main TUI. It asks for
the provider protocol, provider name, model ID, optional base URL, and the name of the API-key
environment variable. If no credential is already available, Dock asks for the key with masked
input and stores it in `~/.dock/.credentials.json` with file mode `0600`. Later launches need only
the `dock` command. A configured environment variable overrides the stored credential.

The first launch in a project also asks whether you trust that workspace before Dock reads project
settings or AGENTS instructions. Trust is stored per project in
`~/.dock/trusted-workspaces.json`; trusting a project covers its descendants.

## Manual configuration

To configure Dock without the first-run flow, create `~/.dock/settings.json`:

```json
{
  "model": "anthropic:claude-model-id",
  "providers": {
    "anthropic": {
      "protocol": "anthropic-messages",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "contextWindow": 200000,
      "maxOutputTokens": 8192
    }
  },
  "permissions": {
    "defaultMode": "default",
    "allow": ["Read", "Glob", "Grep"],
    "ask": [],
    "deny": ["Read(.env)"]
  }
}
```

Supported provider protocols are `anthropic-messages`, `openai-responses`, and
`openai-chat-completions`. API keys use an environment override when present and otherwise come
from the owner-only credential store.
Use a custom `baseUrl` and `apiKeyEnv` on a provider for OpenAI-compatible endpoints.

Startup session flags include `--continue`, `--resume <id|name>`, `--fork-session`, `--model`,
`--name`, and `--permission-mode`.

## Interactive controls

For a frontend-only terminal preview, run `pnpm preview:tui` from this repository in WSL.
This uses the actual `@dock/tui` renderer, not the Dock agent or a browser mockup. No provider,
credential, session, sandbox or tool executor is initialized. F1/F2/F3 select startup/conversation/
permission examples; F4 cycles a mascot drawn in exactly 3, 5 or 7 character rows. Enter plays
fixed sample content, and Ctrl+C exits. A short terminal selects a smaller complete mascot.
The preview shares the production fullscreen components; only its data/controller and demo keys are separate.
See [TUI internals](docs/internals/tui.md) and [preview internals](docs/internals/ui-preview.md).

Dock now uses a fullscreen, application-owned scrollback with a fixed composer and bottom confirmation area.
The five-row character mascot scrolls away with the opening, and compact does not erase the display history.

- Mouse wheel / `PageUp` / `PageDown` scroll history; `Ctrl+Home` / `Ctrl+End` jump to the top/latest output.
  Scrolling up pauses automatic following. `Home` / `End` still edit the input line.
- `Ctrl+O` toggles full thinking, tool parameters/results, and compact summaries; `/search` searches the current transcript.
- Select text with the mouse to copy (OSC 52 support required). `Ctrl+C` copies an existing selection before interrupting/exiting.
- `/` completes implemented commands; `/help` lists commands and shortcuts.
- `Esc` closes search, menus or task details first; in a permission panel it declines that call.
  Otherwise it interrupts the foreground turn without stopping background tasks. Double `Esc` on an empty editor opens rewind.
- `Shift+Tab` cycles the normal permission modes. `Ctrl+C` exits while idle.
- `/resume`, `/branch`, `/clear`, and `/rename` manage sessions without restarting Dock.
- `/model <provider:model-id>` switches adapters, while `/permissions` changes the active mode.
- `/context`, `/compact [instructions]`, and `/rewind` manage the active context and checkpoints.
- `/tasks` opens the task list; Enter opens details and `x` stops the selected task. Normal input in details is sent to that agent,
  with a separate draft; built-in slash commands still affect the main session.
- `/tasks continue <id> [message]` explicitly resumes a stopped task; `/tasks send <id> <message>` sends a follow-up.
  `Ctrl+B` backgrounds a foreground agent without changing its ID.
- `/rewind` offers conversation/files/both; Bash and ordinary subagent edits are not covered by parent file checkpoints.
- `/exit` closes the session cleanly and restores the terminal.

## Context compaction

Automatic compaction first checks time-based tool-result clearing, then summarizes only if
the context is still above its threshold. Manual `/compact [instructions]` requests a summary
directly. Escape cancels compaction without committing a new summary.

The following optional settings use the normal user/project/local precedence:

```json
{
  "contextManagement": {
    "toolResultClearing": {
      "enabled": true,
      "gapThresholdMinutes": 60,
      "keepRecent": 5
    }
  }
}
```

These are Dock's defaults. Enabling time-based clearing by default is an explicitly approved
difference from the reference snapshot. Clearing replaces older tool-result bodies, not user
messages, and does not save large tool outputs to separate files. See
[the compact internals](docs/internals/compact.md) for request, recovery and persistence boundaries.

`pnpm exec tsx scripts/smoke-compaction.mts` runs a small, billed check against the configured
provider using synthetic content only. Cache reuse must be verified from returned usage.

## Bash sandbox

On Linux or WSL2, install the Sandbox Runtime system dependencies once:

```bash
sudo apt-get install bubblewrap socat ripgrep
```

Run `/sandbox` inside Dock and choose auto-allow, regular permissions, or disabled. The default is
disabled. Auto-allow matches Claude Code behavior: Bash calls that actually enter the OS sandbox
skip ordinary approval prompts, while explicit deny rules and critical deletion checks still apply.
The current workspace is writable, Dock credentials are unreadable, and network access is routed
through a domain approval prompt. Persistent domain approvals are stored in
`.dock/settings.local.json`.

## Subagents

Ask Dock to delegate a focused task, or run `/subtask <task>` to explicitly fork the current
conversation in the background. There are no predefined roles or custom role files.
The Agent tool defaults to fresh context; explicit forks inherit the parent model and request
prefix. Fresh agents can select a configured `provider:model`.

`/tasks` lists IDs, states and output files. Use `/tasks <id>` to inspect the transcript,
`/tasks stop <id>` to stop it, `/tasks continue <id> [message]` to resume, and
`/tasks send <id> <message>` to steer it. Model messages cannot restart a user-stopped task.
Ctrl+B backgrounds a foreground delegation without changing its ID; main Escape leaves
background tasks running. Child edits are not covered by the parent's `/rewind`.

Optional configuration (normal user/project/local precedence):

```json
{
  "subagents": { "backgroundEnabled": true, "maxConcurrent": 20, "maxDepth": 3 },
  "worktree": { "baseRef": "fresh" }
}
```

Set `backgroundEnabled` to false for foreground Agent tool calls; explicit `/subtask` remains
background. Set `worktree.baseRef` to `"head"` to start from the caller's current commit.
Agent's `isolation: "worktree"` creates a Dock-owned Git worktree. Changed trees and new commits
are retained; unchanged trees are cleaned up. No dirty files, environment files or dependencies
are copied. Write/Edit cannot write back into the main checkout. Bash only receives the child cwd
and existing permissions/sandbox: **worktree is not a Bash security boundary**.

See [subagent internals](docs/internals/subagents.md) and the
[behavior/source/test alignment](docs/internals/subagents-alignment.md).
`pnpm exec tsx scripts/smoke-subagents.mts` performs a small billed delegation check using synthetic
arithmetic only, without sending project files.
