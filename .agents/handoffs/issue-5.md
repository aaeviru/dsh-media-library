# Issue #5 交接：M3 标签与别名安全管理（v0.3.0）

- 依据契约：[Issue #5 Contract v1](https://github.com/aaeviru/dsh-media-library/issues/5#issuecomment-6918818124)
- 工作树：`/tmp/dsh-media-library-5`；分支：`feat/5-tag-alias-management`（基于 `main` `19f2a8c`）
- 版本：`0.3.0`（根 `package.json`、`bundle/package.json` 与 `migrateDatabase` 默认 `appVersion`）

## 已交付能力（B1–B7）

- **Schema v3 迁移（`src/db/schema.ts`）**：升级前通过 `node:sqlite` `backup()` API 生成 `pre-migrate-v2-to-v3-*.sqlite3`；新增 `tags.archived_at`、`tags.merged_into_id`（外键 `ON DELETE SET NULL`）以及 `mutation_log(id, ts, action, payload_json, result)`；支持失败整事务回滚与 `foreign_key_check` / `integrity_check`。
- **事务写入层（`src/mutations/`）**：
  - `transaction.ts`：统一 `BEGIN IMMEDIATE` 写入封装，强制 `PRAGMA foreign_keys = ON`，成功写入必落 `mutation_log`，任何失败或审计写入失败整事务回滚。
  - `tag-mutations.ts`：`createTag`、`renameTag`、`addAlias`、`removeAlias`、`archiveTag`、`restoreTag` 及非破坏性 `requestDeleteTag`（有引用返回 `TAG_IN_USE`，无硬删除）。严格 `revision` 乐观锁与规范化名称/别名冲突检测。
  - `media-tag-mutations.ts`：`setMediaTags`（上限 `MAX_BATCH_MEDIA = 200`，超限返回 `BATCH_TOO_LARGE`；整批原子；`source='manual'`；自动化路径禁止删除 `manual` 关联）。
  - `merge.ts`：`previewMerge`（只读统计受影响媒体、去重数、迁移/冲突别名数、`tag_parents` 边数及成环检测）与 `mergeTags`（校验预览时 `revision`，去重迁移关联且 `manual` 优先，丢弃冲突别名并审计，迁移父子边并拒绝成环 `MERGE_WOULD_CREATE_CYCLE`，将源标签归档并设置 `merged_into_id`）。
- **Host Remote & React UI**：
  - `src/remote.ts` / `scripts/generate-typert.ts` / `src/client/namespace.ts`：新增 9 个受控 Remote 方法（共 17 个 Typert invocations，经 `@deepseek-ai/dsh-typert-loader` 校验）。
  - `src/client/TagManagementPanel.tsx` / `src/client/BatchTagBar.tsx` / `src/client/MediaLibraryPanel.tsx` / `src/client/locales.ts`：标签创建/重命名/别名/归档恢复/合并预览确认面板、结果表格复选框与批量打标栏（修复了空选后结果横幅随组件卸载的问题），中英文文案齐全，所有字符串按数据渲染。

## Seam Check & Evidence Grading

- **B1–B6（写入、冲突、回滚、审计、v3 迁移）**：`VERIFIED (scope: sqlite_fixture)` — `tests/mutations/*.test.ts` 共 30 项通过；连同既有测试共 62/62 通过；10k/100k 搜索回归 p95 < 200 ms。
- **真实索引副本 v1→v3 隔离升级**：`VERIFIED (scope: isolated_real_index_copy)` — 在 `/home/aaevi/projects/dsh-media-library-local-data/library.sqlite3` 的临时副本上执行升级：原文件 SHA-256（`6ffaaaad2efe63bfd43590120ea8744eedce1c61605ace00bb82dd45376e0131`）前后完全一致；备份生成成功；2,554 条媒体、225 标签、5 别名、185 父子边、3,634 关联、16 文本字段、2,801 legacy IDs 计数 100% 保持，健康检查通过。
- **B7（Client/Host/Remote + UI + XSS）**：`VERIFIED (scope: wsl_dsh_web_cold_install_e2e)` — 冷安装 `.tgz` 到隔离 DSH web profile，Playwright Chromium E2E 覆盖 XSS 载荷纯文本渲染、标签创建/别名/重命名/归档/恢复、批量加标、合并预览与确认，以及 M1/M2 搜索分页右键菜单回归。
- **B8（Windows DSH Desktop 日常工作流验收）**：`NOT_VERIFIED (reason: linux_env_no_windows_smb)` — 待用户在 Windows DSH Desktop 中使用真实索引**副本**冷安装 `.tgz` 实机验收。

## 回滚说明（Two-way Door）

1. 停止 DSH Desktop / 卸载 `0.3.0` 插件。
2. 将 `%DSH_HOME%/media-library/backups/pre-migrate-v2-to-v3-*.sqlite3` 恢复为 `library.sqlite3`。
3. 重新安装 `0.2.0` `.tgz` 包（仅降级插件不会撤销 schema v3）。
