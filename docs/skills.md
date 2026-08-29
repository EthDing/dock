# Skills

Dock 支持 Agent Skills 的可移植基础：发现 Skill、向模型披露 name/description、按需加载
完整 `SKILL.md`，并在 compact 后恢复已激活内容。

## 目录

Dock 在可信项目和用户目录中查找：

- `~/.agents/skills`
- `~/.dock/skills`
- `<project>/.agents/skills`
- `<project>/.dock/skills`

项目定义覆盖用户定义，同一 scope 中 `.dock` 覆盖 `.agents`。

每个 Skill 是包含 `SKILL.md` 的目录：

```markdown
---
name: review
description: Review a change for correctness and regressions.
---

Read the changed code and report concrete findings.
```

`name` 和 `description` 必须存在。其他 Frontmatter 会随原文提供给模型，但不会自动获得
Dock 运行语义。

## 激活

模型可以调用 `Skill` 工具，用户也可以输入 `/skill-name`。同一内容 hash 不会重复注入；
文件变化后会重新加载。`/skills` 显示有效、覆盖、无效和未向模型披露的条目。

Skill 目录中的 `scripts/`、`references/` 和 `assets/` 通过现有文件与 Bash 工具使用，
Dock 不为它们增加专用执行器。项目 Skill 在 workspace trust 前不会加载。
