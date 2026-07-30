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

- `Esc` interrupts the active turn; press `Esc` twice on an empty editor to open rewind.
- `Shift+Tab` cycles the normal permission modes. `Ctrl+C` exits while idle.
- `/resume`, `/branch`, `/clear`, and `/rename` manage sessions without restarting Dock.
- `/model <provider:model-id>` switches adapters, while `/permissions` changes the active mode.
- `/context`, `/compact [instructions]`, and `/rewind` manage the active context and checkpoints.
- `/exit` closes the session cleanly.
