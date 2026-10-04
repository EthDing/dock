# 子 Agent

主 Agent 用 `Agent` 工具把一项任务交给子 Agent。子 Agent 在自己的上下文里完成工作，只把结论
交回来；搜索、翻日志这类中间过程不会占用主对话的上下文。

## 两种上下文

- **fresh**（默认）：从空白开始，重新加载项目指令，只拿到主 Agent 写的任务说明。看不到主对话，
  也不加载主对话的 Auto Memory。可以指定使用其他已配置的模型。
- **fork**：继承主对话的完整历史、模型和工具定义。请求前缀和主对话一致，因此能复用主对话的
  缓存；代价是必须沿用同样的模型和工具。fork 出来的子 Agent 不能再 fork。

fresh 子 Agent 只能从任务说明了解任务，子 Agent 做不好，最常见的原因是任务交代得不清楚。

## 前台与后台

子 Agent 默认在后台运行：`Agent` 调用立即返回，主 Agent 可以继续工作。子 Agent 结束时，Dock
把结果作为一条 `<task-notification>` 送回给派出它的一方；如果主 Agent 此时空闲，Dock 会自动
开始新的一轮处理这条通知，不需要用户再发消息。通知会持久化保存，Dock 重启后也能补发。

- `subagents.backgroundEnabled: false`：改为前台运行，主 Agent 等待结果；
- `Ctrl+B`：把正在前台运行的子 Agent 转到后台。

主 Agent 可以用 `SendMessage` 给运行中的子 Agent 补充说明，消息在子 Agent 两次模型请求之间
送达；用 `TaskStop` 停止子 Agent，已有的输出和记录会保留。子 Agent 的权限请求会显示在主会话
中，并标明是哪个子 Agent 在请求。

子 Agent 可以再派出子 Agent，默认最多嵌套 3 层；同时运行的子 Agent 默认最多 20 个。

```json
{ "subagents": { "backgroundEnabled": true, "maxConcurrent": 20, "maxDepth": 3 } }
```

## Worktree 隔离

`isolation: "worktree"` 让子 Agent 在一个独立的 Git worktree 中工作。所有 worktree 共用同一份
Git 历史，但工作区文件各自独立，多个子 Agent 并行改代码时不会互相覆盖。

- 默认从远端默认分支创建（`worktree.baseRef: "fresh"`），看不到主目录里未提交的改动；设为
  `"head"` 则基于当前 HEAD；
- 子 Agent 的 Write、Edit 不能写回主目录；
- 结束时没有改动就自动删除，有改动就保留，并在通知里给出路径和分支名；
- 合并由主 Agent 或用户用 Git 完成。worktree 把冲突从"运行中互相干扰"推迟到"最后合并时
  一次解决"。

worktree 隔离的是文件，不是安全边界：子 Agent 的 Bash 命令仍然可以访问 worktree 之外的路径。

## 工作任务

`TaskCreate`、`TaskGet`、`TaskList`、`TaskUpdate` 维护一份随会话保存的任务清单，按 ID 增量
更新，支持 owner 和任务之间的依赖关系，循环依赖会被拒绝。主 Agent 和子 Agent 共用同一份清单，
`Ctrl+T` 打开任务视图。
