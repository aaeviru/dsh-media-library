# Issue #4 修复交接：自动验收通过，Windows 实机验收待完成

- 日期：2026-11-16（Asia/Tokyo）；修复者：GPT，单 Agent 执行。
- 执行依据：[Issue #4 Contract v1](https://github.com/aaeviru/dsh-media-library/issues/4#issuecomment-6894894314)。本次会话中用户另行明确批准修改 `tests/db/**`，并批准保留原实现的 [generate-typert.ts](</home/aaevi/projects/dsh-media-library-fix-4/scripts/generate-typert.ts>) 改动；这些会话批准尚未同步成 GitHub Issue 评论。
- 工作树：`/home/aaevi/projects/dsh-media-library-fix-4`；分支：`fix/4-acceptance`。
- 基线：`354260437b76a0d9a2776e32ec1e501a8c149f2f`，不是本次交付的实现 SHA。用户随后明确要求提升版本并按包名、版本、commit 交付；根清单、分发清单及迁移 appVersion 均已更新为 `0.2.0`。本分支提交后由干净 HEAD 构建，包名遵循 `dsh-media-library-0.2.0-<short-sha>.tgz`；实际完整 commit、包名及 SHA-256 记录在产物目录的 `release-0.2.0.json` 中。尚未推送或创建 PR，也没有独立、绑定实现提交 SHA 的 PR Review。
- 从已校验 SHA-256 的原验收源码快照恢复 Gemini 实现及 Codex 验收脚本。原来的 `/tmp/dsh-media-library-4` 工作树已不存在，原任务分支未被更改。

## 已修复的五项验收问题

| 问题 | 根因与修复 | 回归证据 |
| --- | --- | --- |
| B4 allowlist 绕过 | 数据库 root 覆盖了本机 override。构造参数和本机 override 的 `roots`（含空数组）现在优先；数据库的禁用标记也必须通过。 | 空 allowlist 返回 `UNMAPPED_ROOT`；禁用根返回 `DISABLED_ROOT`；覆盖 open/reveal，probe/opener 均不执行。 |
| B3/B6 分页混合查询 | 分页读取尚未提交的表单。现在绑定成功查询快照，新查询清除旧游标，并按请求序号丢弃过期响应。 | 浏览器加载 50 条后修改番号草稿、直接加载更多，结果为 66/66，66 个 ID 无重复；仍可显式提交新查询。 |
| B6 菜单越界 | 菜单直接使用点击坐标。现在按实测尺寸限制在视口内，同时限制宽高。 | 1440×900 右边缘与 640×480 右下角均包含两个可点击动作。窄屏测试显式构造 `MouseEvent`，确保携带真实坐标。 |
| B5 Host 查询开销漏测 | 每次查询都运行迁移和全库健康检查。现在共享一次初始化，查询用短连接；`elapsedMs` 包括连接和初始化成本。 | 基准改为完整 `service.searchMedia`；分别记录冷启动与初始化后的混合查询 p95。 |
| B4 错误状态丢失 | schema v1 不接受 `unmapped`/`permission_denied`，Host 也未写回。新增 v2 迁移并对齐状态写入。 | `getMedia` 和重新搜索均保留状态；恢复可访问后回到 `indexed`；浏览器覆盖缺失、离线、未映射、权限徽章。 |

v2 使用事务重建媒体表：迁移前通过 SQLite backup API 备份；重建前暂时关闭外键执行（避免 CASCADE 清空子表），提交前仍执行 `foreign_key_check` / `integrity_check`，成功或失败后都恢复外键执行。测试覆盖失败回滚、标签关联/文本保留、索引和 AUTOINCREMENT 高水位。v1 定义保持原样，keyset 索引通过 v2 建立。

## 验证与交付追溯

以下数字和旧证据文件属于上一轮 `0.1.0` 未提交快照，仅作为修复效果的历史证据；旧临时安装包不是正式交付。`0.2.0` 将在本分支提交后重新运行同一完整入口，以产物目录的 `release-0.2.0.json` 和 `verify-0.2.0.log` 固定提交、规范包名与本轮验证结果；提交内文档不写入自身 SHA，以避免自引用。

上一轮完整命令（退出码 0）：

```bash
cd /home/aaevi/projects/dsh-media-library-fix-4
npm_config_cache=/home/aaevi/projects/dsh-media-library-local-data/npm-cache ./scripts/verify.sh
```

默认 npm 缓存目录在当前环境只读，因此使用本地数据目录作为验证缓存；未更改用户 npm 配置。

- 格式检查、类型检查、Host/Client 构建、Host 外部导入审计、打包：PASS。
- 单元/SQLite fixture/导入/搜索/基准：**32/32 PASS**。
- 完整 Host 混合查询，初始化后：10k p95 **4.81 ms**；100k p95 **103.62 ms**（10 种 workload × 3 轮，含标签、番号、日期、文本与分页）。
- 冷 Host 初始化 + 第一次搜索：10k **47.88 ms**；100k **649.21 ms**，单独报告，不计作稳态 p95，也未隐藏在返回值之外。
- 六条 fixture 从点击导入到首批结果：**71.3 ms**；100k 数据、约 200k 关联的 UI 搜索/首屏渲染：**52.0 ms**（Host 已初始化，非整个应用冷启动耗时）。
- `.tgz` 隔离冷安装、boot/bundle HTTP、真实 Chromium 与 Host RPC：PASS。覆盖筛选、空态、错误恢复、HTTP 响应闸门下的 busy、键盘、分页及菜单边缘。离线/权限/未映射徽章来自隔离数据库状态 fixture；真实网络错误分类来自 Host mock 测试。
- 真实现有索引的**隔离 SQLite 备份**：v1→v2 后 2,554 条媒体、225 标签、3,634 关联、2,801 legacy IDs 等计数全部保持；分页遍历 2,554 条、零重复、零遗漏；完整性检查通过。原索引和 TagStudio 源副本的 hash 均未改变。

证据与产物目录：`/home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/`：

- [fix-4-verify-final.log](</home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/fix-4-verify-final.log>)：最终统一验证入口的完整输出。
- [fix-4-real-index-upgrade.json](</home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/fix-4-real-index-upgrade.json>)：真实索引隔离备份升级及源 hash 校验。
- [fix-4-verified.tgz](</home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/fix-4-verified.tgz>)：与通过冷安装验证的包逐字节一致的交付副本。
- [fix-4-source.tar.gz](</home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/fix-4-source.tar.gz>) / [fix-4-tracked.patch](</home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/fix-4-tracked.patch>) / [fix-4-manifest.json](</home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/fix-4-manifest.json>)：固定本次未提交源码及包摘要，不含数据库或私密媒体数据。
- [acceptance.md](</home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/acceptance.md>) / [reviewed-source.tar.gz](</home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/reviewed-source.tar.gz>) / [snapshot-manifest.json](</home/aaevi/projects/dsh-media-library-local-data/artifacts/issue-4-acceptance/snapshot-manifest.json>)：原 Codex FAIL 记录与原实现快照，完整保留以供对照。

## 剩余门禁与继续方式

1. **B7 / `windows_smb_e2e`: NOT_VERIFIED (reason: linux_env_no_windows_smb)**。在 Windows DSH Desktop 中冷安装本次包，用真实导入条目验证默认关联确实启动 PotPlayer，并确认 Explorer 选中同一个原文件；补测 NAS 离线/权限错误的真实 UI 行为。Linux 的 `FILE_NOT_FOUND` RPC 只证明接缝，不证明原生窗口效果。
2. 本会话用户已批准额外测试目录、保留契约生成脚本，以及本次版本/commit 交付修正；创建 PR 前将这些范围批准同步到 Issue。PR 使用 `Refs #4`，在 Windows 验收完成前保持 Issue 打开。由独立 reviewer 对实际完整提交 SHA 做审查；本记录不是独立 PR Review。
3. 回滚升级后的本机索引时，停止插件再恢复 `pre-migrate-v1-to-v2-*.sqlite3` 备份；单纯降级插件不能撤销 schema v2。媒体和 TagStudio 源不受此次迁移影响。

未修改 Harness 源码、现用 DSH profile、生产媒体或 TagStudio 数据库。测试服务器使用隔离 DSH_HOME 与端口 3199，验证结束后已由脚本清理；没有替换当前会话的 Web GUI。
