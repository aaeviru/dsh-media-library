# Issue #2 Handoff & Contract Mirror

- **Issue**: https://github.com/aaeviru/dsh-media-library/issues/2
- **Contract Comment**: https://github.com/aaeviru/dsh-media-library/issues/2#issuecomment-6892348852
- **Initial Implementation PR**: https://github.com/aaeviru/dsh-media-library/pull/10 (`2b2f430`)

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
| `B1` | **严格只读与字节不变性证明**：使用 Node 内置 `node:sqlite` 的 `{ readOnly: true }` 模式打开源库；盘点前后分别计算源文件 `SHA-256`、`size`、`mtime`，不一致则立即报错退出 | `PARITY_REQUIRED` | `sqlite_fixture` | `VERIFIED` |
| `B2` | **多候选 `ts_library.sqlite` 鉴别与对比模式**：支持一次传入多个候选 `.sqlite` 路径或目录，输出对比表：`SHA-256`（自动折叠字节完全相同的副本）、文件大小、TagStudio DB 版本、`entries`/`tags`/`tag_aliases`/`tag_entries`/字段总数、路径前缀分布及最大 ID，辅助人类识别真正的最新库与空库/旧备份 | `INTENTIONAL_CHANGE` | `sqlite_fixture` | `VERIFIED` |
| `B3` | 盘点选定源库的 DB 版本、`entries`、`tags`、`tag_aliases`、`tag_entries`、字段表、父子标签层级及孤儿记录（orphans）精确计数 | `PARITY_REQUIRED` | `sqlite_fixture` | `VERIFIED` |
| `B4` | 自动探测番号（catalog number）与日期（media date）在源库中的实际分布（字段 vs 标签 vs 文件名/目录结构），并统计一号多文件情况 | `PARITY_REQUIRED` | `sqlite_fixture` | `VERIFIED` |
| `B5` | 检测大小写折叠后的重复标签名、多标签共享同一别名（歧义别名）、无法映射到 root 的路径与缺失文件；全部输出到机器可读 JSON 与脱敏 Markdown 摘要，零静默丢弃 | `INTENTIONAL_CHANGE` | `sqlite_fixture` | `VERIFIED` |
| `B6` | 生成覆盖非 ASCII 路径、重复标签名、共享别名、缺失文件、一号多文件、孤儿记录的匿名化 TagStudio SQLite fixture 供 M2 自动化测试复用 | `INTENTIONAL_CHANGE` | `sqlite_fixture` | `VERIFIED` |
| `B7` | **真实副本盘点与人类裁决（`D2.1..D2.5`）**：基于真实只读副本完成盘点，并由人类拍板番号/日期提取优先级、孤儿关联处理、重复标签合并及系统附属文件过滤规则 | `INTENTIONAL_CHANGE` | `real_readonly_copy_inventory` | `APPROVED & VERIFIED` |

---

## `[DECISION]` Issue #2 — Real Copy Inventory Summary & Approved M2 Import Rules

- **Authoritative Read-Only Source Fingerprint**:
  - `SHA-256` (Before & After unchanged): `6dc1b799b5e48d938fc8c376fd8715ad913e1771a75d78e708c3f4aede2ee158`
  - `Size`: `2,715,648` bytes | `TagStudio DB Version`: `CURRENT = 400`, `INITIAL = 100`
  - `Counts`: `entries = 2570`, `tags = 226` (`custom = 224`), `tag_aliases = 5`, `tag_entries = 4742` (`valid = 3636`, `orphaned = 1106`), `tag_parents = 185`, `text_fields = 16`, `datetime_fields = 0`

### Approved Rules for M2 (`#3`)

```markdown
[RULE] D2.1 Orphaned tag_entries Reconciliation
- applies_to: M2 TagStudio 导入器处理 tag_entries 关联表
- rule: 仅导入 entry_id 与 tag_id 两端均存在的有效关联（实测 3,636 条）；将其余因 TagStudio 未开启外键遗留的孤儿关联（实测 1,106 条：其中缺 entry 710 条、缺 tag 622 条、两端均缺 226 条）完整记录到 import_runs.report_json 的 orphaned_tag_entries 中，满足 valid + orphaned == total 对账恒等式
- boundary_not_covered: 指向因 D2.5 被主动过滤的附属文件（Thumbs.db / .vsmeta）的标签关联，单独计入 skipped_sidecar_tag_entries 对账项
- source: Issue #2 / B7 (D2.1)
```

```markdown
[RULE] D2.2 Catalog Number Extraction Precedence & Non-Uniqueness
- applies_to: M2 导入及后续媒体番号提取与规范化
- rule: 优先级为 显式 text_fields > filename > 父目录名 > NULL；支持标准番号（ABC-123）、数字前缀番号（300MAAN-341 / 200GANA-2659）、单字母/复合前缀（T28-513 / T-28634 / MBR-AA024）、FC2（FC2-PPV-1234567 与 FC2-1476760 统一规范化为 FC2-PPV-<digits>）及日期索引无码编号（061315_01-10mu -> 10MU-061315_01）；media_files.catalog_number 允许非唯一（支持实测 203 组一号多文件）且允许为 NULL
- boundary_not_covered: 无番号规律的欧美/自拍长标题视频（保持 catalog_number = NULL，通过标题/文件名/标签检索）及单文件合并多个不同番号的合集视频
- source: Issue #2 / B7 (D2.2)
```

```markdown
[RULE] D2.3 Media Date Precedence & No Fabricated Dates
- applies_to: M2 导入时 media_files.media_date 与 added_at 的赋值
- rule: entries.date_added 原样导入 media_files.added_at；业务日期 media_date 严格按 datetime_fields > text_fields 中的 ISO 日期 > 文件名/路径中的 YYYY-MM-DD 提取，未提取到则保持 NULL，严禁用文件 mtime 或 date_added 伪造业务日期
- boundary_not_covered: 仅包含年份或年月的不完整日期字符串（默认保持 NULL）
- source: Issue #2 / B7 (D2.3)
```

```markdown
[RULE] D2.4 Case-Folded Duplicate Tag Consolidation
- applies_to: M2 导入时 tags 表归一化与 legacy_ids 映射
- rule: 标签查询键统一按 trim + lowercase 折叠；对源库中同名重复标签（实测 id=1076 有 13 条有效关联，id=1166 为 0 条关联），合并为单一目标 tag 记录，并在 legacy_ids 中同时保存两个旧 tag_id 到同一新 tag_id 的映射，且在导入报告中显式列出合并明细
- boundary_not_covered: 两个同名标签同时包含冲突的 shorthand 或互斥分类规则时需人工确认
- source: Issue #2 / B7 (D2.4)
```

```markdown
[RULE] D2.5 System & Sidecar File Filtering on Import (Option B)
- applies_to: M2 从 TagStudio entries 导入 media_files 的文件后缀过滤
- rule: 导入时跳过系统缩略图缓存与群晖附属元数据文件（后缀为 .db 如 Thumbs.db 共 9 条、后缀为 .vsmeta 共 7 条），不写入 media_files 主表，但必须将其旧 entry_id、相对路径及关联标签完整记录到 import_runs.report_json 的 skipped_entries 中，确保 imported_entries + skipped_entries == source_entries (2554 + 16 == 2570)
- boundary_not_covered: 用户未来主动放入库的非系统 .db 文件（若文件名非 Thumbs.db 且不在跳过后缀白名单中需在报告中显著提示）
- source: Issue #2 / B7 (D2.5, Human Decision: Option B)
```
