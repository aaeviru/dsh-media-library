# Issue #2 Handoff & Contract Mirror

- **Issue**: https://github.com/aaeviru/dsh-media-library/issues/2
- **Contract Comment**: https://github.com/aaeviru/dsh-media-library/issues/2#issuecomment-6892348852
- **Branch**: `feat/2-tagstudio-inventory`

## `[CONTRACT]` Issue #2 v1 — M1: Inventory the TagStudio library from a read-only copy

### 1. Goal & Scope
- **Goal**: 在绝不修改任何源数据库字节的前提下，提供只读盘点与**多候选库对比工具**，先从多个同名/同 `mtime` 的 `ts_library.sqlite` 中安全识别出真正的生产目标库副本，再完成全量实体/关联/字段/异常盘点并沉淀无损导入规则。
- **Allowed paths**:
  - `src/inventory/**`, `scripts/inventory-tagstudio.ts`, `scripts/verify.sh`
  - `tests/inventory/**`
  - `docs/inventory-report-template.md`
  - `.agents/handoffs/issue-2.md`
- **Forbidden paths**:
  - 严禁对任何源 `ts_library.sqlite` 执行写入、打开读写连接或修改文件属性
  - 严禁将包含真实隐私文件名/路径的盘点报告提交至 Git 仓库（入库测试仅使用匿名化 SQLite fixture）

### 2. Behavior Table (`B1..B7`)

| ID | 行为描述 | 分类 | 证据要求 | 状态 |
|---|---|---|---|---|
| `B1` | **严格只读与字节不变性证明**：使用 Node 内置 `node:sqlite` 的 `{ readOnly: true }` 模式打开源库；盘点前后分别计算源文件 `SHA-256`、`size`、`mtime`，不一致则立即报错退出 | `PARITY_REQUIRED` | `sqlite_fixture` | 实现并由单测验证 |
| `B2` | **多候选 `ts_library.sqlite` 鉴别与对比模式**：支持一次传入多个候选 `.sqlite` 路径或目录，输出对比表：`SHA-256`（自动折叠字节完全相同的副本）、文件大小、TagStudio DB 版本、`entries`/`tags`/`tag_aliases`/`tag_entries`/字段总数、路径前缀分布及最大 ID，辅助人类识别真正的最新库与空库/旧备份 | `INTENTIONAL_CHANGE` | `sqlite_fixture` | 实现并由单测验证 |
| `B3` | 盘点选定源库的 DB 版本、`entries`、`tags`、`tag_aliases`、`tag_entries`、字段表、父子标签层级及孤儿记录（orphans）精确计数 | `PARITY_REQUIRED` | `sqlite_fixture` | 实现并由单测验证 |
| `B4` | 自动探测番号（catalog number）与日期（media date）在源库中的实际分布（字段 vs 标签 vs 文件名/目录结构），并统计一号多文件情况 | `PARITY_REQUIRED` | `sqlite_fixture` | 实现并由单测验证 |
| `B5` | 检测大小写折叠后的重复标签名、多标签共享同一别名（歧义别名）、无法映射到 root 的路径与缺失文件；全部输出到机器可读 JSON 与脱敏 Markdown 摘要，零静默丢弃 | `INTENTIONAL_CHANGE` | `sqlite_fixture` | 实现并由单测验证 |
| `B6` | 生成覆盖非 ASCII 路径、重复标签名、共享别名、缺失文件、一号多文件、孤儿记录的匿名化 TagStudio SQLite fixture 供 M2 自动化测试复用 | `INTENTIONAL_CHANGE` | `sqlite_fixture` | 实现并由单测验证 |
| `B7` | **待盘点后人类裁决（`D2.1`）**：基于候选库对比结果选定唯一权威源库副本，并拍板番号/日期提取优先级、标签大小写敏感性、共享别名与一号多文件规则（附带 `boundary_not_covered`） | `UNRESOLVED` | 真实副本盘点后裁决 | `NEEDS_DECISION`（待对用户真实副本运行 CLI 后裁决） |

### 3. Shared Seams & High-Risk Rule Boundaries

```markdown
[RULE] Read-Only Source Library Invariant
- applies_to: 所有针对 TagStudio ts_library.sqlite 候选文件的对比、盘点与后续 M2 导入操作
- rule: 必须以只读模式（readOnly: true）打开候选文件，且操作前后校验 SHA-256 哈希完全一致；若目录中存在 -wal / -shm 文件，盘点报告必须显式告警（提示源库可能未正常关闭或存在未 checkpoint 数据）
- boundary_not_covered: 正在被 TagStudio 进程实时写入的在线数据库（必须先关闭 TagStudio 或复制静态副本后再盘点）
- source: Issue #2 / B1-B2
```
