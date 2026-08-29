# 工具

模型只能通过当前请求中提供的工具执行操作。所有工具输入先验证，再进入权限判断和执行。

## 文件与搜索

- `Read`：读取文本文件。
- `Write`：创建或覆盖文件。
- `Edit`：执行精确字符串替换。
- `Glob`：按 glob 查找路径。
- `Grep`：在文件中搜索文本。

文件工具使用绝对路径。工作区外读取、写入和用户规则仍会进入权限系统。

## Bash

`Bash` 在项目目录中运行 `/bin/bash -lc`。Dock 不尝试完整解析 Shell 语义，也不会因为
命令看起来只读就自动批准；普通命令由权限规则、sandbox 状态或用户确认决定。

递归删除关键路径的断路器优先于 bypass 和 sandbox auto-allow。多条 Bash 调用按串行执行。

## 用户交互与 Plan

`AskUserQuestion` 可以提出最多四个问题，支持单选、多选和 Other 自由输入。后台子 Agent
提问时，面板会显示其来源。

主 Agent 可以使用 `EnterPlanMode` 进入只读规划模式，再用 `ExitPlanMode` 提交当前计划。
用户可以按 default 或 acceptEdits 模式批准，也可以提供反馈继续规划。子 Agent 不能切换
主会话的 Plan mode。

## 工作任务

`TaskCreate`、`TaskGet`、`TaskList` 和 `TaskUpdate` 维护持久任务清单。任务支持 pending、
in_progress、completed、owner 和依赖关系；循环依赖会被拒绝。

`/tasks` 同时显示工作任务和子 Agent，`Ctrl+T` 可以快速打开或关闭工作任务视图。

## 网络

`WebFetch` 获取一个公开 HTTP(S) URL，并使用当前 model 根据 `prompt` 处理内容。它按
domain 请求权限，拒绝 localhost、私网和 link-local 地址，也拒绝非文本响应、过大内容和
过多跳转。

当前没有 WebSearch 工具。

## 子 Agent 与 Skill

`Agent` 创建通用子 Agent；`SendMessage` 发送后续方向；`TaskStop` 停止运行中的子 Agent。
`Skill` 激活已发现的 `SKILL.md`。详情见[任务与子 Agent](tasks-and-subagents.md)和
[Skills](skills.md)。
