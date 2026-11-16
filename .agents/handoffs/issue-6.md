# Issue #6 交接：M3 备份、恢复与冷备运维化（v0.4.0）

- 依据契约：[Issue #6 Contract v1](https://github.com/aaeviru/dsh-media-library/issues/6#issuecomment-6921304435)
- 工作树：`/tmp/dsh-media-library-6`；分支：`feat/6-backup-restore-ops`（基于 `main` `7c8adec`）
- 版本：`0.4.0`

## 已交付能力（B1–B7）

- **在线安全备份与分级轮转（`src/db/ops.ts`, `src/config.ts`）**：
  - `createOperationalBackup` 通过 `node:sqlite` `backup()` API 生成时间戳备份并运行 `PRAGMA integrity_check` + `PRAGMA foreign_key_check`。
  - **仅在新备份校验通过后**执行清理：默认保留最近 **14 份**日常备份（`library-backup-*.sqlite3`）与 **5 份**迁移前备份（`pre-migrate-*.sqlite3`），绝不删除非插件命名的用户文件。
  - 可选 `nasBackupDir`：将校验通过的本地备份复制到 NAS 归档目录并按同规则轮转（绝不直接对 NAS 运行 SQLite `backup()`）；NAS 不可写仅告警不阻断本地备份。
- **每日自动备份防重（`B2`）**：`maybeRunDailyAutoBackup` 检查距上次成功备份 ≥ 24h 且 `mutation_log` / `import_runs` 有新变化才生成自动备份，库无变化时跳过；手动触发不受 24h 限制。
- **空目录恢复与只读降级模式（`B3`, `B4`, `src/spike-service.ts`）**：
  - `restoreDatabaseFromBackup` 可还原到空目录并校验表计数与健康度。
  - 启动检测到未来 Schema 版本、迁移失败或完整性异常时，Host 进入 `READ_ONLY_DEGRADED`：允许只读搜索、诊断、备份与映射导出，所有写入统一拒绝并返回 `READ_ONLY_DEGRADED`。
- **便携映射报告导出（`B5`）**：`exportPortableMappingReport` 支持 JSON 与 RFC 4180 转义（含公式注入防护）CSV。
- **UI 运维面板与文档（`B6`, `B7`）**：[MediaLibraryPanel.tsx](file:///tmp/dsh-media-library-6/src/client/MediaLibraryPanel.tsx) 新增顶部只读降级告警条与「备份与运维」抽屉；[operations-and-recovery.md](file:///tmp/dsh-media-library-6/docs/operations-and-recovery.md) 记录冷备切换、无回写说明、RTO/RPO、恢复步骤与两周观察期要求。

## Seam Check & Evidence Grading

- **B1–B5（备份、轮转、防重、恢复、只读降级、JSON/CSV 导出）**：`VERIFIED (scope: sqlite_fixture)` — `tests/db/backup-ops-and-degraded.test.ts` 5 项全通过，连同全库共 **67/67** 通过；10k p95 **5.54 ms**，100k p95 **108.98 ms**。
- **真实索引副本演练（`B7`）**：`VERIFIED (scope: isolated_real_index_copy)` — 在 `/home/aaevi/projects/dsh-media-library-local-data/library.sqlite3` 临时副本上完成升级→备份→空目录恢复→JSON/CSV 导出，2,554 条媒体 / 225 标签 / 5 别名 / 185 父子边 / 3,634 关联 / 16 文本字段 / 2,801 legacy IDs 计数 100% 匹配，原库 SHA-256 未变。
- **WSL `dsh web` 冷安装 + Playwright E2E（`B6`）**：`VERIFIED (scope: wsl_dsh_web_cold_install_e2e)` — 覆盖打开「备份与运维」面板、点击「立即备份」及备份列表刷新、导出 JSON 与 CSV 报告，及 M1/M2/M3 全部回归。
- **两周日常使用观察期 & Windows 实机检查**：`NOT_VERIFIED (reason: linux_env_and_2week_observation_window)` — 运维机制与恢复演练已就绪；两周观察期与 Windows 桌面实机检查由用户日常使用完成。
