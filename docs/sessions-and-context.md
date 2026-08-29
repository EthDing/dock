# 会话与上下文

Dock 将会话追加写入 `~/.dock/projects/`。每条消息使用稳定 UUID 和 parent chain，
损坏的未完成尾部不会替代已提交历史。

## 会话操作

- `--continue`：继续当前项目最近会话。
- `--resume <id-or-name>` 或 `/resume`：恢复指定会话。
- `--fork-session` 或 `/branch`：从当前有效历史创建新会话。
- `/rename`：命名会话。
- `/clear`：开始空的新会话，旧会话仍可 resume。

## Checkpoint 与 rewind

每个用户 prompt 创建 checkpoint。`Write` 和 `Edit` 修改前保存可恢复状态。`/rewind`
可以回退对话、文件或两者。

Bash、外部进程、普通子 Agent 和未被 Dock 文件工具跟踪的修改不在父会话恢复范围内。

## Compact

自动 compact 先按时间清理符合条件的旧工具结果；如果上下文仍接近上限，再请求模型生成
摘要。`/compact [instructions]` 可以手动压缩，Esc 在提交前取消。

compact 后，Dock 重新加载当前项目指令和 Memory 索引，并在预算内恢复最近读取的文件。
显示历史仍保留完整对话，模型只使用 compact 后的有效上下文。

## Auto Memory

Auto Memory 是项目级普通文件存储，不是向量数据库。Dock 在上下文中放入 Memory 索引，
需要时使用普通文件工具读取主题文件。回合结束后的后台提取可能补充长期有价值的信息；
失败不会推进提取游标。
