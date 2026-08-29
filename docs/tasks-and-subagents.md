# 任务与子 Agent

Dock 区分两种任务：

- 工作任务：由 TaskCreate/Get/List/Update 管理的计划状态。
- 子 Agent：拥有独立对话和执行生命周期的委派任务。

`/tasks` 将两者显示在同一界面中，但它们的状态和操作不同。

## 工作任务

工作任务随根 session 持久化。子 Agent 可以读取和更新同一任务清单。branch 复制当前任务
快照，resume 恢复原任务，clear 创建空清单。

任务可以设置 owner、active form 和阻塞关系。删除任务时，其他任务对它的依赖引用也会
删除。

## 子 Agent

`Agent` 默认使用 fresh context 在后台启动，也可以显式使用 fork：

- fresh：重新加载项目指令，不继承父对话和主 Auto Memory。
- fork：继承父请求前缀、model、工具定义和历史快照。

子 Agent 有独立消息、compact 状态、取消信号和文件读取状态。`SendMessage` 可以在模型
轮次边界投递方向；已完成任务可按原 ID 恢复。用户停止的任务必须由用户明确继续。

`/subtask <prompt>` 从当前主对话创建后台 fork。`Ctrl+B` 将前台子 Agent 转为后台。

## Worktree

Agent 的 `isolation: "worktree"` 在 Git 仓库中创建 Dock 所有的独立 worktree。Write/Edit
不能写回主 checkout；有修改或新提交的 worktree 会保留并返回路径。

未提交文件和依赖不会自动复制，也不会自动合并。Bash 只获得子 cwd，不能把 worktree 当作
命令安全边界。
