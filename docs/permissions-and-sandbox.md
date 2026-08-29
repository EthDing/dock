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
- `dontAsk`：不能弹窗的操作直接拒绝。
- `bypassPermissions`：跳过普通询问，但显式 deny/ask 和关键安全断路器仍有效。

## Bash sandbox

Ubuntu 依赖：

```bash
sudo apt-get install bubblewrap socat ripgrep
```

在 Dock 中运行 `/sandbox` 选择 disabled、regular-permissions 或 auto-allow。auto-allow
只适用于确实进入 sandbox 的 Bash 调用；显式规则和关键删除检查仍然执行。

sandboxed Bash 的工作目录可写，Dock 凭据不可读，网络通过 domain approval。未进入
sandbox 的 Bash 拥有启动 Dock 的用户权限。Git worktree 不是 Bash 安全边界。
