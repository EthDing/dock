# 配置

Dock 使用 JSON 设置，按以下顺序加载，后者覆盖前者：

1. `~/.dock/settings.json`
2. `<project>/.dock/settings.json`
3. `<project>/.dock/settings.local.json`

`settings.local.json` 适合只属于本机的权限和 sandbox 设置，不应提交到 Git。

## Model 与 provider

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
  }
}
```

支持的 protocol：

- `anthropic-messages`
- `openai-responses`
- `openai-chat-completions`

`baseUrl` 可以将 OpenAI protocol 指向兼容 endpoint。环境变量中的 key 优先于
`~/.dock/.credentials.json` 中的凭据。

## 常用设置

```json
{
  "permissions": {
    "defaultMode": "default",
    "allow": ["Read", "Glob", "Grep"],
    "ask": [],
    "deny": ["Read(.env)"]
  },
  "sandbox": {
    "enabled": false,
    "autoAllowBashIfSandboxed": true
  },
  "subagents": {
    "backgroundEnabled": true,
    "maxConcurrent": 20,
    "maxDepth": 3
  },
  "worktree": {
    "baseRef": "fresh"
  },
  "contextManagement": {
    "toolResultClearing": {
      "enabled": true,
      "gapThresholdMinutes": 60,
      "keepRecent": 5
    }
  },
  "autoMemoryEnabled": true
}
```

permission mode 可选 `default`、`acceptEdits`、`plan`、`dontAsk` 和
`bypassPermissions`。`worktree.baseRef` 可选 `fresh` 或 `head`。

启动参数包括 `--continue`、`--resume`、`--fork-session`、`--model`、`--name` 和
`--permission-mode`。运行 `dock --version` 查看版本。
