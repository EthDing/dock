# 权限与 sandbox

权限决定一个工具调用能不能执行，sandbox 决定获准执行的 Bash 命令能碰到什么。两者是不同的层，
不能互相替代。

## 规则

规则写在 settings 的 `permissions` 里，可以针对整个工具，也可以针对具体内容：

```json
{
  "permissions": {
    "deny": ["Read(.env)", "WebFetch(domain:internal.example.com)"],
    "ask": ["Bash(git push*)"],
    "allow": ["Bash(npm test)", "WebFetch(domain:docs.example.com)"]
  }
}
```

审批时选择"总是允许"，规则会写入项目的 `.dock/settings.local.json`。

## 判定顺序

每个工具调用按固定顺序判定，命中哪一步就停在哪一步：

1. 整个工具被 deny：拒绝。
2. 整个工具被设为 ask：询问。
3. 工具自己检查输入，例如文件工具判断路径是否在工作目录内，Bash 识别递归删除关键路径。
   工具给出 deny 时拒绝；命中内容规则的 ask，或者属于必须确认的操作时，询问。
4. `bypassPermissions` 模式：放行。
5. 整个工具被 allow：放行。
6. 工具检查给出 allow：放行。
7. 以上都没有决定：`plan` 模式拒绝，其他模式询问。

这个顺序有三个特点：deny 永远先于 allow；工具自己的安全检查排在权限模式之前，所以
`bypassPermissions` 也绕不过递归删除关键路径的确认；用户写的规则先于模式生效。

## 权限模式

| 模式 | 行为 |
|---|---|
| `default` | 规则没有覆盖的操作都询问 |
| `acceptEdits` | 工作目录内的文件编辑自动放行，其余照常 |
| `plan` | 只做研究和读取，修改环境的操作被拒绝，直到计划获批 |
| `auto` | 由分类器模型代替人审批，见下文 |
| `dontAsk` | 只执行预先允许的操作，需要询问的直接拒绝 |
| `bypassPermissions` | 跳过普通询问；显式 deny、ask 和工具的安全检查仍然有效 |

用 `--permission-mode` 或 `permissions.defaultMode` 设置，TUI 中用 `Shift+Tab` 或 `/permissions`
切换。

### Plan 模式

主 Agent 可以调用 `EnterPlanMode` 进入只读的规划模式，调研之后用 `ExitPlanMode` 提交计划。计划
是一次工具调用，而不是一段文字提问，所以 Dock 能拦住它、展示给用户。用户可以按 `default`、
`acceptEdits` 或 `auto` 批准，也可以附上反馈要求继续规划。批准后，完整的计划作为工具结果交回
模型。子 Agent 不能切换主会话的 plan 模式。

## Auto 模式

auto 模式用一个分类器模型代替人做审批。

### 三层放行

1. 只读工具、Dock 内部的任务和计划工具，以及用户写的 allow 规则，直接放行。进入 auto 时，
   能执行任意代码的宽泛 allow 规则会被临时撤掉，例如 `Bash(*)`、带通配符的解释器和包管理器的
   `run`、`exec`，以及对 `Agent` 的 allow；离开 auto 后自动恢复，settings 文件不会被修改。
   否则一条宽泛规则就能让最危险的命令绕过分类器。
2. 工作目录内的普通文件编辑直接放行，因为这些改动可以用版本控制审查和回滚。但写 `.dock`、
   `.git`、`.ssh`、shell 启动文件、Git 和包管理器的配置这类受保护路径，即使有 allow 规则也会
   交给分类器；判断路径时会先解析符号链接。
3. 其余操作，包括 Bash、WebFetch、派出子 Agent、工作目录外的文件操作，都由分类器判断。

显式的 deny 和 ask 规则仍然排在分类器之前。

### 分类器看什么

分类器只看用户的原始消息和 agent 的工具调用。agent 自己写的文字和思考、工具结果、压缩摘要、
项目指令和 Skill 内容，它都看不到。

- 看不到 agent 的文字，agent 就无法说服分类器；
- 看不到工具结果，文件或网页里藏着的注入指令也就碰不到它。

判断的核心是用户意图：agent 自己决定要做的事，在用户明确要求之前不算授权。

### 两阶段

第一阶段只输出"放行"或"拦截"，拿不准就拦；只有被拦下的操作才进入第二阶段，用同一份提示词
重新判断，这次要求先推理再下结论。两个阶段共用请求前缀，第二阶段能复用第一阶段的缓存。

分类器的检查限时 60 秒。超时、出错或返回内容无法解析，一律按拦截处理。

### 被拦之后

被拦的调用作为一个错误的工具结果返回给模型，附上原因，并要求它换一种更安全的做法，不要绕过
拦截。连续拦截 3 次或累计拦截 20 次后，交互模式下后续需要分类器审查的操作改为询问用户。主
Agent 和它的子 Agent 共用这个计数。

### 配置

分类器默认使用当前会话的模型，也可以单独指定。提示词模板是固定的，可以补充三类内容：

```json
{
  "permissions": {
    "defaultMode": "auto",
    "auto": {
      "model": "primary:classifier-model",
      "environment": "可信的仓库和内部服务。",
      "blockRules": ["禁止修改生产数据库。"],
      "allowExceptions": ["允许删除本任务创建的测试数据。"]
    }
  }
}
```

默认只信任当前 Git 仓库。默认的拦截规则覆盖四类风险：破坏或外传数据、降低安全性、跨越
信任边界、绕过审查或影响他人。

auto 模式会增加模型请求、延迟和费用。它比完全跳过审批安全得多，但不能代替 sandbox，也不能
代替对高风险操作的人工审查。

## Bash sandbox

sandbox 在操作系统层面限制 Bash 命令，基于 `@anthropic-ai/sandbox-runtime`（Linux 上使用
bubblewrap）。在 Ubuntu 上安装 `bubblewrap`、`socat` 和 `ripgrep` 后，运行 `/sandbox` 选择
关闭、启用并照常审批，或启用并自动放行。

### 边界

- **写**：只允许写工作目录和 `sandbox.filesystem.allowWrite` 中的目录；Dock 的设置文件和凭据
  始终不可写。
- **读**：默认可读，Dock 的凭据文件始终不可读，可以用 `filesystem.denyRead` 补充。
- **网络**：命令没有直接的出网路径，所有连接经过本机代理，按域名放行。权限规则里
  `WebFetch(domain:...)` 的 allow 和 deny 会同时并入 sandbox 的域名列表；未知域名会询问用户，
  无界面时拒绝。
- **环境变量**：provider 的 API key 环境变量不会传进 sandbox。

### 和权限的配合

开启自动放行后，确实进入 sandbox 的 Bash 命令不再逐条询问：边界由操作系统保证，比按命令文本
匹配规则更可靠。显式规则和递归删除关键路径的确认仍然生效；`plan` 模式下自动放行不起作用；
`auto` 模式下，sandbox 中的命令仍然要经过分类器。

不进入 sandbox 的情况：命令匹配 `sandbox.excludedCommands`，或者模型请求在 sandbox 外运行（可以
用 `allowUnsandboxedCommands: false` 关闭）。这些命令照常走权限判定。`failIfUnavailable: true`
时，sandbox 无法启动就直接报错，不退回到无隔离运行。

sandbox 只包住 Bash。Read、Write、Edit、WebFetch 等内置工具由权限规则管理。
