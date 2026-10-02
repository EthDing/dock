# 开始使用

## 安装

Dock 的安装器需要 Linux 或 WSL2，以及 Node.js 24 或更高版本。它不会使用 `sudo`，
默认安装到 `~/.local/share/dock`，并在 `~/.local/bin/dock` 创建命令入口。

```bash
curl -fsSL https://raw.githubusercontent.com/EthDing/dock/main/install.sh | bash
dock
```

如果 `~/.local/bin` 不在 `PATH` 中，安装器会打印需要添加的路径。

安装指定版本：

```bash
curl -fsSL https://raw.githubusercontent.com/EthDing/dock/main/install.sh | bash -s -- --version 0.1.0
```

重复运行安装命令即可更新。下载内容会经过 SHA-256 校验；下载、校验或替换失败时，已有
安装保持不变。Dock 的用户设置、会话和凭据保存在 `~/.dock`，更新不会删除它们。

卸载：

```bash
rm -rf ~/.local/share/dock
rm -f ~/.local/bin/dock
```

## 首次启动

在希望 Dock 工作的项目目录中运行：

```bash
cd your-project
dock
```

如果尚未配置 model，Dock 会询问：

1. API protocol。
2. provider name。
3. model ID。
4. 可选 base URL。
5. API key 使用的环境变量名。

找不到对应环境变量或本地凭据时，Dock 会使用隐藏输入读取 API key。第一次进入项目还会
询问 workspace trust；确认前不读取项目设置、项目指令或项目 Skills。

配置完成后，也可以不启动 TUI，执行一次任务并退出：

```bash
dock -p "检查这个项目"
```

输出格式、权限和自动化行为见 [Headless 模式](headless.md)。

## 从源码运行

开发环境需要 Node.js 24、pnpm 10.34.5 和 Git：

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli.js
```

运行 `pnpm run ci` 执行格式、lint、类型检查、测试和构建。
