# dsh-media-library

[English](README.md) | [简体中文](README.zh-CN.md)

面向 Windows 优先的 DSH Desktop 媒体库插件（`@deepseek-ai/dsh-experimental-media-library`），用于管理、搜索、打标和入库群晖 NAS 媒体文件：原始媒体留在 NAS SMB 共享上，标签与索引元数据保存在 Windows 本机 SQLite 数据库中。

## 当前状态

**M1–M4 已全部实现**（当前基线：`v0.7.10`，SQLite Schema `v7`）。

- **M1（Host / UNC 边界与盘点）**：白名单 Windows UNC 路径安全解析、原生默认应用打开（如 PotPlayer）与 Explorer `/select` 定位、TagStudio 只读数据库盘点。
- **M2（只读迁移、搜索与打开）**：从 TagStudio `ts_library.sqlite` 无损只读导入（导入前后校验源库 SHA-256 不变）、版本化 SQLite 迁移、支持标签/别名（多标签交集）、番号（精确/前缀）、日期范围与关键词的 keyset 分页搜索，以及右键菜单/快捷键原生打开与定位。
- **M3（标签管理与运维恢复）**：标签创建/重命名/别名管理/归档与恢复、批量打标、带影响预览的事务化标签合并、审计日志、在线 SQLite 备份与保留清理（支持可选 NAS 冷备复制）、只读降级保护，以及便携 JSON/CSV 映射报告导出。
- **M4（可恢复入库与演员规则）**：异步暂存目录扫描、元数据抓取（`FC2CMADB` / `FC2PPVDB`）、人工审核门禁、确定性演员别名规则与人工审核队列、非阻塞异步 Host 文件执行、进程级移库/恢复串行互斥、默认关闭的 EXDEV 复制保护（`allowCrossDeviceCopy: false`）、有界 3×1 MiB 已有目标抽样校验与崩溃恢复。

> **明确不做**：内嵌播放器、转码、缩略图生成/缓存、Synology Photos 集成，以及在 SMB 共享上直接读写在线 SQLite。

## 架构概览

```text
React 页面（DSH Web / Desktop 客户端）
   │  Typert Remote（只传 mediaId、tagId 与受控查询参数，绝不接收任意 UNC 路径）
   ▼
DSH Host（唯一可信边界 & 唯一 SQLite 写入者）
   ├─ 本机 SQLite（%DSH_HOME%/media-library/library.sqlite3，schema v7）
   ├─ 白名单媒体根目录（root_id + relative_path -> \\NAS\Share\...）
   ├─ 异步入库与恢复（进程级互斥、默认同卷 rename、可选 EXDEV 校验复制）
   └─ DSH native-command（默认应用打开 / Windows Explorer 定位选中）
                                   │
                                   ▼
                        NAS SMB 共享上的原始媒体文件
```

### 核心不变量
1. **只读 TagStudio 源库**：绝不修改原始 `ts_library.sqlite`，导入前后强制校验源库 SHA-256 未变化。
2. **本机 SQLite 存储**：在线数据库和备份始终位于本机 NTFS/SSD（`%DSH_HOME%/media-library/`），严禁放到 SMB 共享或插件包目录中。
3. **Host 路径安全边界**：Client 只能传 ID 与受控参数，所有 Windows UNC 路径由 Host 基于数据库与白名单根目录重建，并经 `path.win32` 包含性校验。

## 主要配置项

插件配置定义于 [`src/config.ts`](src/config.ts)：

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `uncRoot` | `\\NAS\MediaTest` | NAS 媒体共享的规范 Windows UNC 根路径（如 `\\SynologyNAS\Media`）。 |
| `dataDir` | `media-library` | `%DSH_HOME%` 下的本机子目录，用于存放 `library.sqlite3` 和 `backups/`。 |
| `stagingDir` | `""` | 待入库视频暂存目录（留空默认 `<uncRoot>\temp`）。请与 `uncRoot` 保持在同一 SMB 共享下以走瞬间 `rename`。 |
| `ingestionTargetSubdir` | `ingested` | 审核通过后的文件在 `uncRoot` 下的固定目标子目录。 |
| `allowCrossDeviceCopy` | `false` | 仅当 `rename` 返回 `EXDEV` 时允许开启带完整大小 + SHA-256 校验的复制回退；默认关闭以防止静默跨卷复制。 |
| `nasBackupDir` | `""` | 可选的 NAS 归档目录，用于复制已通过完整性校验的本机 SQLite 备份。 |
| `autoDailyBackup` | `true` | 每 24 小时最多自动创建一次已校验的本机备份（仅在存在新写入/导入时触发）。 |
| `tagstudioCopyPath` | `""` | 可选的只读 TagStudio `ts_library.sqlite` 副本路径，用于一键导入。 |

## 开发、验证与打包

运行仓库统一的五步验证脚本（Git 卫生检查 → 构建/类型检查/外部依赖审计 → 单元/SQLite/基准测试 → `.tgz` 打包 → 隔离 WSL DSH Web 冷安装 + Playwright 端到端测试）：

```sh
./scripts/verify.sh
```

单独构建并打包用于 Windows DSH Desktop 冷安装的 `.tgz` 安装包：

```sh
./scripts/build-bundle.sh
./scripts/pack.sh ./dist
```

> 请始终使用打包产出的 `.tgz` 进行冷安装，不要使用 `link:` 目录安装。备份、恢复与版本回滚步骤请参见 [docs/operations-and-recovery.md](docs/operations-and-recovery.md)。

## 文档索引

- [设计提案与基线](docs/design.md)
- [备份、恢复与 TagStudio 冷备运维手册](docs/operations-and-recovery.md)
- [开发与 Agent 协作工作流规范](docs/development/workflow.md)
- [领域术语表（Glossary）](GLOSSARY.md)
- 架构决策记录（ADR）：
  - [ADR 0001：M1 UNC 路径打开实现](docs/adr/0001-m1-unc-path-opener.md)
  - [ADR 0002：暂存扫描与可恢复移库](docs/adr/0002-staging-scan-and-move.md)
  - [ADR 0003：非阻塞 Host 与串行化入库](docs/adr/0003-responsive-host-and-serialized-ingestion.md)
  - [ADR 0004：标签层级 DAG 与分类角色正交设计](docs/adr/0004-tag-hierarchy-and-kind.md)

## 参考项目

- [dsh-downloader](https://github.com/aaeviru/dsh-downloader)
- [dsh-plugin-docs](https://github.com/aaeviru/dsh-plugin-docs)
- [TagStudio](https://github.com/TagStudioDev/TagStudio)
