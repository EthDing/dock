<h1 align="center">Dock</h1>

<p align="center">运行在终端中的 coding agent。</p>

<p align="center">
  <img src=".github/assets/dock-tui.png" alt="Dock TUI" width="900" />
</p>

Dock 使用 TypeScript 构建，提供模型与工具循环、权限控制、持久会话、context compact、
Auto Memory、通用子 Agent、Agent Skills 和全屏 TUI。

目前支持 Linux 和 WSL2。macOS 尚未完整测试，Windows 原生暂不支持。

## 快速开始

```bash
curl -fsSL https://raw.githubusercontent.com/EthDing/dock/main/install.sh | bash
dock
```

如果尚未配置 model，Dock 会在启动时引导选择 provider 和 model；找不到对应凭据时才会
询问 API key。进入 Dock 后，使用 `/help` 查看命令和快捷键。

如需启用 Bash sandbox，请先在 Ubuntu 安装 `bubblewrap`、`socat` 和 `ripgrep`，然后运行
`/sandbox`。

更多使用说明见 [Dock 用户文档](docs/README.md)。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm run ci
```

使用 `pnpm preview:tui` 可以在不连接模型的情况下预览 TUI。
