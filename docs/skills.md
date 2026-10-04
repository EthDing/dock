# Skills

Skill 是一份按需加载的操作说明，遵循 [Agent Skills](https://agentskills.io/specification) 开放格式。
平时模型只知道"有这份说明、它适合什么时候用"，用到时才读入全文。

## 目录

Dock 在以下位置查找 Skill，同名时后面的覆盖前面的：

1. `~/.agents/skills`
2. `~/.dock/skills`
3. `<project>/.agents/skills`
4. `<project>/.dock/skills`

项目里的 Skill 要等目录被信任后才会加载。

每个 Skill 是一个包含 `SKILL.md` 的目录，frontmatter 必须有 `name` 和 `description`：

```markdown
---
name: review
description: Review a change for correctness and regressions. Use before merging.
---

Read the changed code and report concrete findings.
```

`description` 是模型决定要不要用这个 Skill 的唯一依据，要写清楚它做什么、什么时候用。

## 三层加载

| 层 | 内容 | 什么时候进入上下文 |
|---|---|---|
| 1 | 所有 Skill 的 name 和 description | 会话开始 |
| 2 | `SKILL.md` 全文 | 模型调用 `Skill` 工具，或用户输入 `/skill-name` |
| 3 | `scripts/`、`references/`、`assets/` 中的文件 | 正文用到时，通过 Read、Bash 读取或运行 |

Skill 列表写在 `Skill` 工具的描述里，会话期间保持不变，不影响 prompt cache。会话中途新增的
Skill 要重启后才会出现在列表中。

## 激活

正文作为一条消息追加进对话，并标明 Skill 所在的目录，让模型能正确解析 Skill 内的相对路径。
同一份内容不会重复注入；文件改动后再次激活，会注入新内容。超过约 10000 token 的 Skill 不会加载。

`/skills` 显示有效、被覆盖和无效的 Skill，以及原因。

## 压缩之后

Skill 正文是对话里的一条消息，压缩时会被摘要掉。所以[压缩](context.md)之后，Dock 会把用过的
Skill 重新放回上下文：

- 最近用过的排在前面；
- 每个最多约 5000 token，超出时保留开头，并注明完整 `SKILL.md` 的位置，模型需要时可以自己去读；
- 总量约 25000 token，放不下的较早 Skill 会列出名字，提示模型需要时重新激活。

截断时保留开头，所以 Skill 里最重要的规则应该写在前面。
