# Headless 模式

使用 print mode 执行一次任务并退出：

```bash
dock -p "检查并修复类型错误"
cat prompt.txt | dock -p
```

如果同时提供 stdin 和位置参数，stdin 内容放在前面，位置参数作为最后的任务要求。
Headless 不运行首次配置或 workspace trust 交互；model、credential 和项目信任必须已经
通过交互模式配置。

## 运行选项

```text
--model <provider:model>
--permission-mode <mode>
--max-turns <positive-integer>
--output-format text|json|stream-json
--no-memory
```

`--max-turns` 只统计产生 tool use 的模型轮次，不统计最终纯文本回答。达到上限后，Dock
不会执行下一批工具，结果以 `error_max_turns` 结束。

`--no-memory` 只关闭本次运行的 Auto Memory：不加载、不写入，也不调度后台提取。项目
AGENTS、Skills 和其他上下文仍然生效，设置文件不会被修改。

## 输出

`text` 是默认格式，只向 stdout 写最终回答。诊断和失败信息写入 stderr。

`json` 最终写入一个版本化对象：

```json
{
  "schema_version": 1,
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "session_id": "...",
  "result": "..."
}
```

`stream-json` 使用 NDJSON，依次输出 `system/init`、已提交的 user/assistant 消息、上下文
管理事件和最终 result。第一版不输出 token 级 delta。错误 subtype 为
`error_max_turns`、`error_during_execution` 或 `error_aborted`。

成功退出码为 `0`，未完成或执行错误为 `1`，SIGINT 为 `130`。

## 权限与生命周期

Headless 无法显示确认面板。需要询问的工具和网络访问默认拒绝；已有权限规则、指定的
permission mode 和 sandbox auto-allow 仍然适用。`AskUserQuestion` 和需要用户选择的计划
交互会得到明确的 headless tool error。

Session 仍然写入磁盘，可以稍后在 TUI 中 resume。子 Agent 在 headless 中以前台方式
运行；主任务不会在子 Agent 尚未完成时退出。

`dock -p --permission-mode auto "任务"` 会用分类器审批未预先允许的工具调用。拦截作为错误
tool_result 返回，模型可以选择安全替代方案；连续 3 次／累计 20 次拦截也不会结束进程，
被拦的操作仍不执行，后续调用继续检查。超时或分类失败同样拒绝执行。显式 ask 规则仍拒绝，
不会转给分类器放行；`--max-turns` 等已有结束条件不变。
