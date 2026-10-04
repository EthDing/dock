# 权限与 sandbox

权限系统决定工具能否执行，sandbox 决定获准运行的 Bash 进程能够访问什么。二者不是同一
层，也不能互相替代。

## 规则

规则可以针对整个工具：

```json
{
  "permissions": {
    "deny": ["Write"],
    "ask": ["Bash"],
    "allow": ["Read"]
  }
}
```

也可以限制内容：

```json
{
  "permissions": {
    "deny": ["Read(.env)", "WebFetch(domain:internal.example.com)"],
    "allow": ["Bash(git status)", "WebFetch(domain:docs.example.com)"]
  }
}
```

整体 deny、整体 ask 和工具自身安全判断优先于 bypass 与 allow。无法判断的操作在 default
模式询问用户，在 dontAsk 和 plan 模式拒绝。session approval 只覆盖普通默认询问，不覆盖
显式 ask 或 deny。

## Permission modes

- `default`：未预先允许的操作询问用户。
- `acceptEdits`：自动接受普通 Write/Edit，其他操作保持原规则。
- `plan`：允许研究和读取，拒绝会修改环境的 passthrough 操作。
- `auto`：自动接受普通工作目录文件操作，其余未预先批准的操作交由模型分类器审批。
- `dontAsk`：不能弹窗的操作直接拒绝。
- `bypassPermissions`：跳过普通询问，但显式 deny/ask 和关键安全断路器仍有效。

## Auto 模式

用 `dock --permission-mode auto` 启动，或设置 `permissions.defaultMode: "auto"`。
TUI 中可用 Shift+Tab 或 `/permissions` 切换；计划批准面板提供 “Approve · auto permissions”。
分类器默认使用正在调用工具的会话模型，主会话切换模型后也随之切换；需要独立模型时配置
`permissions.auto.model`，格式与 `model` 相同，复用已有 provider 和凭据配置。

```json
{
  "permissions": {
    "defaultMode": "auto",
    "auto": {
      "model": "primary:your-classifier-model",
      "environment": "团队批准的仓库和内部服务清单。",
      "blockRules": ["禁止修改生产数据库。"],
      "allowExceptions": ["允许删除当前任务创建的本地测试夹具。"]
    }
  }
}
```

`auto` 及其全部字段都可省略；三个策略槽位是在内置策略上补充，不能替换固定判定模板。
多层 settings 中环境文本与规则列表依次追加，模型选择沿用最后一层。默认只信任当前 git
仓库；默认拦截规则覆盖破坏／外传数据、降低安全性、跨越信任边界、绕过审查／影响他人。
分类器要求高风险操作有明确覆盖目标与后果的用户授权，agent 自行选定的操作不算授权。

判定顺序：

1. 保留显式 deny 和 ask 规则及关键删除确认；ask 走人工审批，headless 下拒绝。
2. 继续放行工作目录内的 Read/Glob/Grep、内部任务和计划工具，以及有效的用户 allow 规则。
   auto 会临时过滤任意执行能力的宽泛 allow，包括 `Bash(*)`、通配解释器、包管理器 run/exec、
   Agent/SendMessage 的 allow；`Bash(npm test)` 等窄规则保留。过滤不改 settings，离开 auto
   自动恢复。auto 下 Bash 的窄 allow 必须匹配完整命令，不能仅凭其中一段批准复合命令。
3. 工作目录内普通 Write/Edit 自动放行；`.dock`、`.git`、`.husky`、`.ssh`、shell 启动文件、
   git／部分包管理器配置等受保护路径始终送分类器，即使有 Write/Edit allow。路径检查会解析
   符号链接，无法确定位置、硬链接或特殊文件也送审；文件范围规则并非操作系统隔离。
4. 其余 Bash、WebFetch、Agent、SendMessage 和工作目录外文件操作由分类器审批；sandbox
   的 Bash auto-allow 不跳过此步骤。主、子 agent 和后台记忆提取适用同一检查，记忆提取还保留
   自己更严格的工具范围限制。

分类器只读取原始用户消息及工具调用参数，不读取 assistant 文字／思考、工具结果、工具调用
描述、AGENTS／Skill 内容或压缩摘要。实际在 UI 作出的问答与计划批准会记为用户消息；
agent 的委派消息不会被提升为用户授权。会话压缩后仍从原始历史提取这些信息。

第一阶段只允许 `ALLOW` 或 `BLOCK`，拿不准就拦；只有有效的 `BLOCK` 进入第二阶段，先推理
再给结论。两阶段复用相同模板和历史前缀，仅末尾指令不同，并向支持的 provider 标记缓存边界；
实际缓存命中取决于 provider。整个检查限时 60 秒，超时、异常、截断或格式错误均拒绝执行，
不会把 provider 的原始错误内容回传给 agent。

被拦的调用作为错误 tool_result 返回原因，并要求寻找更安全的做法、不得绕过。连续 3 次或
累计 20 次分类器拒绝后，交互模式中后续需要分类器审查的操作改为人工审批；触发阈值的操作
仍然拒绝。此时保留 auto 标记和过滤后的规则，避免恢复宽泛 allow 导致跳过审批。计数由同一
主会话及其子 agent 共享；连续计数只在分类器放行后归零，累计计数和人工回退状态在当前运行
的会话中保留。Headless 达到阈值后继续分类、拒绝危险调用和运行后续轮次，不因此退出。

auto 会增加模型请求、延迟和费用，模型审批不保证安全，也不能替代 sandbox 或敏感操作的
人工审查。本实现不包含服务端 prompt injection 探测器。设计参考
[Anthropic auto mode 工程文章](https://www.anthropic.com/engineering/claude-code-auto-mode)；
Headless 达到阈值继续运行是 Dock 的行为。

## Bash sandbox

Ubuntu 依赖：

```bash
sudo apt-get install bubblewrap socat ripgrep
```

在 Dock 中运行 `/sandbox` 选择 disabled、regular-permissions 或 auto-allow。auto-allow
只适用于确实进入 sandbox 的 Bash 调用；显式规则和关键删除检查仍然执行。
在 `auto` 权限模式下，sandbox Bash 仍须经过权限分类器；sandbox 的网络 domain approval
保持独立，未预先允许的域名仍会询问，headless 下拒绝。

sandboxed Bash 的工作目录可写，Dock 凭据不可读，网络通过 domain approval。未进入
sandbox 的 Bash 拥有启动 Dock 的用户权限。Git worktree 不是 Bash 安全边界。
