# 开始使用

## 安装

需要 Linux 或 WSL2，以及 Node.js 24 或更高版本：

```bash
curl -fsSL https://raw.githubusercontent.com/EthDing/dock/main/install.sh | bash
```

Dock 安装到 `~/.local/share/dock`，命令入口在 `~/.local/bin/dock`，不需要 `sudo`。下载包经过
SHA-256 校验，任何一步失败都不会影响已有的安装。重复运行安装命令即可更新；指定版本用
`bash -s -- --version <版本号>`。

用户设置、会话、记忆和凭据都在 `~/.dock` 下，更新和卸载 Dock 本身不会动它们。

## 首次启动

在项目目录中运行 `dock`。第一次使用时，Dock 依次询问 API protocol、provider 名称、model ID、
可选的 base URL，以及存放 API key 的环境变量名；环境变量不存在时用隐藏输入读取 key。

第一次进入某个项目时，Dock 还会询问是否信任这个目录。信任之前，项目里的设置、指令和
Skills 都不会加载，避免仓库里提交的配置直接改变 agent 的行为。

## 配置

设置按以下顺序加载，后加载的覆盖先加载的：

1. `~/.dock/settings.json`
2. `<project>/.dock/settings.json`
3. `<project>/.dock/settings.local.json`（只属于本机，不要提交）

```json
{
  "model": "primary:your-model-id",
  "providers": {
    "primary": {
      "protocol": "anthropic-messages",
      "apiKeyEnv": "ANTHROPIC_API_KEY",
      "contextWindow": 200000
    }
  }
}
```

`protocol` 可选 `anthropic-messages`、`openai-responses`、`openai-chat-completions`；`baseUrl`
可以指向兼容的 endpoint。`contextWindow` 默认 200000，决定[自动压缩](context.md)的时机。
`maxOutputTokens` 默认 32000，模型不支持这么大的输出时，API 会返回 400，此时调小即可。

其他设置在对应的页面中介绍：权限和 sandbox、子 Agent、上下文管理、Auto Memory。

## 从源码运行

需要 Node.js 24、pnpm 10.34.5 和 Git：

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js
```

`pnpm run ci` 运行格式检查、lint、类型检查、测试和构建。
