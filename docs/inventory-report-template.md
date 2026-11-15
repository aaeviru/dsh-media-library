# TagStudio Read-Only Inventory & Candidate Comparison Guide (M1 / Issue #2)

本指南说明如何使用内置只读工具（基于 Node 标准库 `node:sqlite` `{ readOnly: true }`，零第三方依赖，跨 Windows / Linux 直接运行）完成：

1. **多候选库鉴别（`--compare` / `--auto`）**：当你有多个同名且最后修改时间（`mtime`）相同的 `ts_library.sqlite` 副本时，安全识别出哪一个是真正的最新库、哪一个是字节完全相同的重复副本、哪一个是空壳库或旧备份。
2. **单库完整盘点**：统计版本、实体、关联、孤儿记录、番号与日期来源分布、标签大小写冲突、共享别名与相对路径映射，并验证操作前后源库 `SHA-256` 完全不变。

---

## 1. 运行命令（Windows 或 Linux 均适用，要求 Node >= 24.9）

> **安全保证**：工具内部强制使用 `new DatabaseSync(path, { readOnly: true })` 打开数据库，并在读取前后自动校验文件 `SHA-256`、`size` 和 `mtimeMs`。但仍建议针对已关闭 TagStudio 的备份副本执行。

### 场景 A：你有多个 `ts_library.sqlite`，不知道哪个是目标库

直接传入包含这些 `.sqlite` 的父目录或多个文件路径：

```sh
# 仅对比所有候选库并打印推荐结果
node scripts/inventory-tagstudio.ts --compare <目录或文件1> [目录或文件2 ...]

# 自动对比所有候选库，并对推荐的主候选库（PRIMARY_CANDIDATE）执行完整盘点
node scripts/inventory-tagstudio.ts --auto <目录或文件1> [目录或文件2 ...] \
  --sanitize \
  --json /tmp/tagstudio-inventory.json \
  --markdown /tmp/tagstudio-inventory.md
```

对比表会按以下规则分类每个候选文件：
- `PRIMARY_CANDIDATE`：条目数、标签关联数、自定义标签数和 DB 版本最完整的候选库；
- `DUPLICATE_OF_PRIMARY`：与主候选库 `SHA-256` 完全一致的重复拷贝（即使在不同目录）；
- `EMPTY_OR_SEED_ONLY`：`entries = 0` 且只有 TagStudio 默认内置标签（ID 0/1）的空初始化库；
- `OLDER_OR_SMALLER_SNAPSHOT`：条目或关联数少于主候选库的历史备份。

### 场景 B：你已确定唯一目标 `ts_library.sqlite` 副本

```sh
node scripts/inventory-tagstudio.ts /path/to/ts_library.sqlite \
  --root-id nas-main \
  --media-root /optional/path/to/mounted/media \
  --sanitize \
  --json /tmp/tagstudio-inventory.json \
  --markdown /tmp/tagstudio-inventory.md
```

- `--sanitize`：将报告中的目录名和文件名替换为单向哈希摘要（保留扩展名与统计计数），便于粘贴到 GitHub Issue 评论中而不泄露任何私密文件名。
- `--media-root`（可选）：如果当前机器能访问媒体根目录，顺带检查数据库中的相对路径在磁盘上是否存在。

---

## 2. Issue #2 盘点裁决回填模板（供粘贴至 Issue #2 评论）

运行上述命令后，将生成的脱敏摘要与以下裁决块贴回 [Issue #2](https://github.com/aaeviru/dsh-media-library/issues/2)：

```markdown
## [DECISION] Issue #2 — TagStudio Inventory & Import Rules

- **选定源库副本 SHA-256**: `<sha256>`（确认盘点前后哈希未变）
- **TagStudio DB Version**: `<version>`
- **核心计数**: `entries=<N>`, `tags=<N> (custom=<N>)`, `tag_aliases=<N>`, `tag_entries=<N>`, `text_fields=<N>`, `datetime_fields=<N>`

### D2.1 番号（Catalog Number）提取优先级与一号多文件策略
- **Decision**: 优先级采用 `<text_fields / filename / directory / tag>`；`media_files.catalog_number` 允许非唯一（支持同一番号对应多分段/附属文件）。
- **boundary_not_covered**: 单文件合并多个不同番号的合集视频。

### D2.2 日期（Media Date）提取优先级与缺失值策略
- **Decision**: 优先级采用 `datetime_fields > text_fields 中的 ISO 日期 > 路径/文件名中的 YYYY-MM-DD > NULL`；未知日期保持 `NULL`，不以文件 `mtime` 或 `date_added` 伪造业务日期。
- **boundary_not_covered**: 仅含年份（`YYYY`）或年月（`YYYY-MM`）的不完整日期。

### D2.3 标签大小写折叠与共享别名处理
- **Decision**: 查询键统一执行 `trim + lowercase` 折叠；导入时通过 `legacy_ids` 保留原 TagStudio tag ID，若存在大小写重名标签或共享别名，在导入报告中显式列出供 M3 合并/消歧，不静默丢弃任何关联。
- **boundary_not_covered**: 跨语种同义演员名自动合并（留待 M4 `performer_aliases` 审核队列处理）。
```
