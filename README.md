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

## Configuration

Create `~/.dock/settings.json`:

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
`openai-chat-completions`. API keys are read only from the configured environment variable.
Use a custom `baseUrl` and `apiKeyEnv` on a provider for OpenAI-compatible endpoints.

Build and start Dock:

```bash
pnpm build
node dist/cli.js
```

Startup session flags include `--continue`, `--resume <id|name>`, `--fork-session`, `--model`,
`--name`, and `--permission-mode`.

## Interactive controls

- `Esc` interrupts the active turn; press `Esc` twice on an empty editor to open rewind.
- `Shift+Tab` cycles the normal permission modes. `Ctrl+C` exits while idle.
- `/resume`, `/branch`, `/clear`, and `/rename` manage sessions without restarting Dock.
- `/model <provider:model-id>` switches adapters, while `/permissions` changes the active mode.
- `/context`, `/compact [instructions]`, and `/rewind` manage the active context and checkpoints.
- `/exit` closes the session cleanly.
