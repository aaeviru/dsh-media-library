# Issue #7 交接：M4 可恢复媒体入库与源站标签抓取（v0.5.0）

- 依据契约：[Issue #7 Contract v1](https://github.com/aaeviru/dsh-media-library/issues/7#issuecomment-6922757618)
- 工作树：`/tmp/dsh-media-library-7`；分支：`feat/7-recoverable-ingestion`（基于 `main` `753b287`）
- 版本：`0.5.0`

## 已交付能力（B1–B6）

- **Schema v4 迁移（`src/db/schema.ts`）**：升级前通过 SQLite `backup()` 自动备份；新增 `ingestion_manifests` 表及状态/校验和索引，向后兼容 v3 数据。
- **源站元数据抓取（`src/ingestion/metadata-fetcher.ts`）**：
  - 纯 TypeScript 实现 `parseCmadbHtml`（提取 `data-page="app"` JSON 的 `title` / `writer` / `tags`）与 `parsePpvdbHtml` 兜底解析；支持限速延迟、重试与可选 Cookie。
  - 遇登录页/401/403 返回 `auth_or_blocked`，绝不绕过登录或验证码。
- **可恢复入库状态机（`src/ingestion/ingestion-service.ts`）**：
  - `previewStagingPlan`（Dry-Run）：只预览 `temp` 扫描与 `uncRoot + ingestionTargetSubdir + 原文件名` 目标路径，零文件或数据库变更。
  - `scanAndPlanStagingFiles`：在 NAS 内部 `temp` 目录扫描视频，按 `sha256:size` 幂等生成 `planned` Manifest。
  - `reviewIngestionManifest`：人工筛选/增删标签并批准后才转为 `reviewed`；未审核调用 `commitIngestion` 直接返回 `REVIEW_REQUIRED`。
  - `commitIngestionManifest`：`reviewed → moving → 复制并校验 size/sha256 → 事务写入 media_files + media_tags(source='ingestion') + mutation_log → indexed → 保守删除 temp 源文件`。重复重放绝不重复建档或打标。
  - `reconcileIngestionManifests`：自动对账恢复三类断点：`copied-not-deleted`、`moved-not-indexed`、`indexed-but-missing`。
- **React 界面 & Remote API（`src/client/IngestionPanel.tsx`, `src/remote.ts`）**：新增 6 个受控 Remote 方法（共 26 个 Typert invocations）与「待入库审核」面板；严格遵守 `READ_ONLY_DEGRADED` 写保护。

## Seam Check & Evidence Grading

- **B1–B5（Schema v4、Dry-Run、解析器、审核门禁、幂等重放、3 类断点恢复、降级拦截）**：`VERIFIED (scope: sqlite_fixture + local_unit_mocked)` — `tests/ingestion/recoverable-ingestion.test.ts` 4 项全通过，连同全库 **71/71** 通过；10k p95 **7.58 ms**，100k p95 **166.56 ms**。
- **B6（WSL `dsh web` 冷安装 + Playwright E2E）**：`VERIFIED (scope: wsl_dsh_web_cold_install_e2e)` — 覆盖打开「待入库审核」面板、空态与扫描错误边界，及 M1/M2/M3 全部回归。
- **B7（真实 NAS `temp` → 固定目标目录端到端验收）**：`NOT_VERIFIED (reason: linux_env_no_windows_smb)` — 全部测试仅使用临时沙箱目录；正式环境启用需用户在 Windows DSH Desktop 实机非生产演练确认后单独批准。
