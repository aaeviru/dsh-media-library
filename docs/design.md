# `dsh-media-library` 设计提案

> 状态：设计草案；未修改 TagStudio、NAS 或任何生产数据，也未提交代码。  
> 调研基线（2026-11-11）：DSH `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`、`dsh-downloader` `d1c44670ef17578b8cd7f0464f20a44bc9b58a02`、`dsh-plugin-docs` `920baf5538fcaa1e9d7e833d077ab39a664171d7`、TagStudio `873de7e5bbeabb8d7103811e9e5bedbabf041b32`。

## 1. 结论

建议把第一版做成 **Windows DSH Desktop 的单机插件：React 页面 + Typert Remote + Host；SQLite 放在 Windows 本机的 DSH 数据目录，NAS 只保存原始媒体**。不要把正在写入的 SQLite 放在 SMB 共享上，也不要在第一版引入 NAS 常驻 API。

推荐的数据流是：

```text
React 页面
   │  Typert：只传查询条件、media_id、tag_id
   ▼
DSH Host（唯一可信边界、唯一 DB writer）
   ├─ 本机 SQLite：标签、别名、媒体索引、文件关联、迁移记录
   ├─ 根目录映射：root_id + relative_path → \\NAS\share\...
   └─ DSH native-command：默认应用打开 / Explorer 定位
                                  │
                                  ▼
                         NAS 上的原始图片/视频
```

这一选择把最常用的搜索、加减标签和别名管理留在低延迟、可事务化的本机数据库中，同时继续让 NAS 成为媒体文件的唯一事实来源。以后若确实需要多台电脑并发管理，再把 Host 后面的存储接口替换为 NAS API；React 页面和 Remote 契约不必重写。

## 2. 范围

### 必须实现

- 保留并管理现有标签、标签别名、标签与文件的关联。
- 按标签、番号（catalog number）和日期搜索；组合条件默认取交集。
- 搜索结果右键：
  - 用 Windows 文件关联打开原始 SMB 文件；视频关联为 PotPlayer 时应由 PotPlayer 打开；
  - 在 Explorer 中定位并选中文件。
- 为后续自动入库和“演员 → 标签”自动关联保留稳定接口。

### 明确不做

- 内嵌播放、转码、缩略图生成或缓存。
- Synology Photos 集成。
- 第一版自动移动/重命名下载文件。
- 第一版多用户并发编辑。
- 继续把 TagStudio 作为日常运行依赖；它只作为一次性迁移源和应急回退工具。

## 3. 已验证事实与 M1 假设

### 已从一手源码验证

1. **DSH Host 已有“默认应用打开”和“Explorer 定位”能力，不需要假设 Electron `shell` API。** `SessionController.openWorkspacePath()` 先验证 Host 路径；省略 `action` 时调用 `openNativeAssociatedPath`，`action: "reveal"` 时调用 `revealNativePath`。[源码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/session-controller/src/index.ts#L353-L428)
2. Windows 默认应用打开由 DSH 的 native-command 运行 `explorer.exe <file-uri>`；定位由 `explorer.exe /select, <file-uri>` 完成。实现以独立 argv 调用，不经过 shell。[源码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/util/native-command/src/path-opener.ts#L101-L166) [定位实现](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/util/native-command/src/path-opener.ts#L274-L313)
3. DSH 单元测试明确覆盖 UNC：`\\server\share\a,b.txt` 被编码为 `file://server/share/a%2Cb.txt` 并传给 Explorer；同一组测试还覆盖 `\\?\UNC\...`、非 ASCII 和逗号。[测试](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/util/native-command/tests/path-opener.spec.ts#L100-L132) [UNC reveal 测试](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/util/native-command/tests/path-opener.spec.ts#L471-L482)
4. `openWorkspacePath` 不是任意命令执行入口：它要求非空路径，经 `fs.processPathFromHostPath()` 映射并再次解析成相同规范路径，否则在执行原生命令前拒绝。[源码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/api/session-controller/src/index.ts#L418-L428) 本地文件系统只接受绝对 Host 路径。[源码](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/fs/fs-local/src/index.ts#L145-L164)
5. 这不是 Electron 主进程 API 方案：Desktop 把完整 Web Host 作为 Electron RunAsNode 子进程运行，[官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/apps/desktop/README.md#L38-L44)；插件 Host 应使用 DSH Host/native-command，而不是 `import electron` 或假设 preload 暴露了 `shell`。
6. DSH Downloader 已证明目标插件形态可行：Host 继承 `TypertRemoteService`，客户端挂载生成的 `/remote`，页面注册到 `main` 和 `sidebar.panellist`。[Host 示例](https://github.com/aaeviru/dsh-downloader/blob/d1c44670ef17578b8cd7f0464f20a44bc9b58a02/src/remote.ts#L1-L47) [Client 示例](https://github.com/aaeviru/dsh-downloader/blob/d1c44670ef17578b8cd7f0464f20a44bc9b58a02/src/client/index.ts) [Slot 示例](https://github.com/aaeviru/dsh-downloader/blob/d1c44670ef17578b8cd7f0464f20a44bc9b58a02/src/client/mount.ts#L13-L25)
7. TagStudio 当前把条目、标签、别名和关联存入 `.TagStudio/ts_library.sqlite`；`TagAlias`、`Tag`、`Entry`、`tag_entries` 是明确的表/模型。[模型](https://github.com/TagStudioDev/TagStudio/blob/873de7e5bbeabb8d7103811e9e5bedbabf041b32/src/tagstudio/core/library/alchemy/models.py#L38-L229) [关联表](https://github.com/TagStudioDev/TagStudio/blob/873de7e5bbeabb8d7103811e9e5bedbabf041b32/src/tagstudio/core/library/alchemy/joins.py#L18-L23)
8. TagStudio 的路径相对于库根保存，因此不同 Windows 映射仍可访问；但官方文档明确说当前不支持多人同时访问同一库。[文档](https://github.com/TagStudioDev/TagStudio/blob/873de7e5bbeabb8d7103811e9e5bedbabf041b32/docs/libraries.md#L59-L86)
9. TagStudio 有版本表、逐步迁移和迁移前备份；当前源码 DB 版本是 400。[版本](https://github.com/TagStudioDev/TagStudio/blob/873de7e5bbeabb8d7103811e9e5bedbabf041b32/src/tagstudio/core/library/alchemy/constants.py#L12-L17) [迁移器](https://github.com/TagStudioDev/TagStudio/blob/873de7e5bbeabb8d7103811e9e5bedbabf041b32/src/tagstudio/core/library/alchemy/migrations.py#L44-L137) [备份触发](https://github.com/TagStudioDev/TagStudio/blob/873de7e5bbeabb8d7103811e9e5bedbabf041b32/src/tagstudio/core/library/alchemy/library.py#L500-L519)

### 仍需在 M1 实机证明

- 当前 DSH Desktop 版本、当前 profile 组合是否暴露并允许复用 `session.openWorkspacePath`，或新插件 Host 是否应直接依赖/内联 `@deepseek-ai/dsh-native-command`。
- 真实 NAS 凭据、SMB 版本及具体 UNC 路径下，Explorer 是否能稳定选中文件；源码测试只证明 argv/编码行为，DSH 文档也明确说命令成功不等于窗口一定已打开或选中。
- `.mp4/.mkv` 的 Windows 默认关联当前是否确为 PotPlayer。插件不应写注册表或硬编码 PotPlayer；验收前由用户在 Windows 设置默认应用。
- NAS 文件名的极端字符、超长路径、离线/唤醒延迟的真实行为。
- TagStudio 实际生产库的版本、字段使用方式，以及“番号/日期”当前存于字段、路径、文件名还是标签；迁移规则必须先做只读盘点。

这些不是设计已成立的事实；它们是 M1 的 go/no-go 门。

## 4. 架构方案比较

| 方案 | 优点 | 主要风险/成本 | 结论 |
|---|---|---|---|
| A. Windows 本机 SQLite，NAS 只放媒体 | 单 writer；搜索快；事务、备份、回滚简单；NAS 离线时仍能浏览索引 | 另一台电脑不能直接编辑；需备份元数据 | **推荐 M1–M4 基线** |
| B. SQLite 直接放 SMB 共享 | 表面上最少组件，多个客户端可看到同一文件 | 网络文件系统锁、断线、延迟和并发写风险；TagStudio 自身也不支持多人同时访问 | **不推荐**；SQLite 官方明确说 WAL 不能工作在网络文件系统，locking 文档也建议不要把 DB 放在网络文件系统。[WAL](https://www.sqlite.org/wal.html) [locking](https://www.sqlite.org/lockingv3.html) |
| C. NAS 本地 DB + 小型 HTTP API | DB 在 NAS 本地磁盘；未来支持多客户端、统一 ingestion | 要部署、升级、鉴权、TLS/网络 ACL、健康检查和备份一个服务；第一版复杂度显著上升 | **未来候选**；出现第二个真实写客户端时再做 |
| D. 直接继续读写 TagStudio DB | 无初始数据复制 | 紧耦合 TagStudio schema/迁移；双写锁；无法真正停止依赖 | **仅做只读迁移源，不做运行架构** |

建议 SQLite 路径为 `%DSH_HOME%/media-library/library.sqlite3`（默认 `%USERPROFILE%/.dsh/media-library/library.sqlite3`），而不是 profile 的 `node_modules`、插件安装目录或 NAS。安装/升级插件不会覆盖数据。可配置的 `backupDir` 可指向本机另一个磁盘；将备份额外复制到 NAS是运维策略，不是在线 DB 位置。

## 5. 组件与契约

### Client（React）

- `MediaLibraryPage`：搜索栏、标签筛选、日期范围、结果表、分页。
- `TagManager`：标签重命名、别名增删、合并标签；危险操作需预览影响条目数。
- 右键菜单只携带 `mediaId`，不把任意路径提交给 Host。
- 无预览播放器和缩略图；结果只显示标题、番号、日期、演员标签、路径状态。

### Typert Remote

建议最小 API：

```ts
search({ text?, tagIds?, catalogNumber?, dateFrom?, dateTo?, cursor?, limit? })
getMedia({ mediaId })
listTags({ query?, cursor?, limit? })
createTag({ name, aliases? })
updateTag({ tagId, name?, aliases? })
mergeTags({ sourceTagId, targetTagId })
setMediaTags({ mediaId, add?, remove? })
openMedia({ mediaId })
revealMedia({ mediaId })
```

写 API 返回新的 `revision`；Client 传 `expectedRevision` 做乐观并发检查，即使目前只有一个 UI，也可防重复点击或旧页面覆盖新值。`openMedia/revealMedia` 只接收 ID，Host 从数据库重建路径并校验，不能接收 Client 提供的 UNC 字符串。

### Host

- 唯一数据库连接所有者；写入串行化，短事务。
- 保存配置、执行迁移、备份、搜索、标签操作和打开文件。
- 对每次打开：查 `media_id` → 取 `root_id/relative_path` → 安全解析 → 可选 `stat` → 调用 DSH 原生 opener。
- 日志只记录 `media_id`、动作和错误类别；默认不记录完整私密 UNC 路径。

## 6. 路径模型与安全边界

不要把 `Z:\...` 或完整 UNC 当成每条记录的唯一身份。使用：

```text
media_roots(id, name, canonical_unc_root, enabled)
media_files(id, root_id, relative_path, ...)
UNIQUE(root_id, relative_path)
```

例如根为 `\\NAS\Media`，记录为 `2026\11\ABC-123\video.mkv`。这样盘符变化不影响索引，也能在未来 NAS API 中把同一 `root_id` 映射到 NAS 本地路径。

Host 解析规则：拒绝空值、NUL、绝对 relative path、盘符、UNC 前缀和 `..` 越界；使用 `path.win32` 规范化；解析后的路径必须仍位于规范根之下；根必须在配置 allowlist 中。Windows SMB 身份验证交给当前 Windows 会话/凭据管理器，插件不保存 NAS 密码。

安全边界是 Host，不是 React：

- Client 只能请求已有 `media_id`，不能请求任意本机文件。
- 所有 SQL 使用绑定参数；排序字段来自枚举，不拼接用户文本。
- Remote 沿用 DSH 的 authenticated connection/principal；若创建自有 HTTP 路由，必须复用 Host/Origin 与登录 cookie 防线，而不是只监听 localhost 就视为安全。
- 标签文本、标题和路径作为数据渲染，不允许注入 HTML。
- 默认不提供删除媒体文件的能力；删除索引也应与物理删除严格分离。

## 7. 数据库模型与搜索

建议第一版 schema：

```sql
schema_versions(version, applied_at, app_version)
media_roots(id, name, canonical_unc_root, enabled, created_at)
media_files(
  id, root_id, relative_path, filename, extension,
  title, catalog_number, media_date, added_at,
  file_size, file_mtime, status, source_key, revision
)
tags(id, name, normalized_name, kind, created_at, updated_at, revision)
tag_aliases(id, tag_id, alias, normalized_alias)
media_tags(media_id, tag_id, source, confidence, created_at)
import_runs(id, source_type, source_fingerprint, started_at, finished_at, status, report_json)
legacy_ids(source_type, source_id, entity_type, entity_id)
```

约束/索引：

- `UNIQUE(root_id, relative_path)`；`UNIQUE(catalog_number)` 不建议默认开启，因为同一番号可能有多文件/分段。
- `UNIQUE(tags.normalized_name)`；`UNIQUE(tag_id, normalized_alias)`；是否允许不同标签共享同一别名需在 M1 盘点后决定，默认允许但搜索时显示歧义。
- `PRIMARY KEY(media_id, tag_id)`；外键开启，删除 tag 使用 `RESTRICT`，合并走显式事务。
- 索引：`catalog_number`、`media_date`、`media_tags(tag_id, media_id)`、`tag_aliases(normalized_alias, tag_id)`、`filename`。

查询语义：

- 番号：输入先做 trim、大小写折叠和常见连字符规范化；支持 exact 与 prefix，UI 明示模式。
- 日期：ISO `YYYY-MM-DD`，范围两端包含；未知日期保持 `NULL`，不能伪造为文件 mtime。
- 标签：名称与别名解析为 tag ID；多标签默认 `AND`，以后可加 `OR/NOT`，第一版不复制 TagStudio 的完整查询语言。
- 通用文本：M1 可对 `title/catalog_number/filename` 做参数化 `LIKE`；数据量或延迟证明需要后再引入 FTS5。不要先做未经度量的全文索引。
- 分页使用稳定 keyset（如 `media_date DESC, id DESC`），避免大 offset。

`media_tags.source` 预留 `tagstudio-import | manual | ingestion | performer-rule`，`confidence` 仅用于自动建议。人工确认后可转为 `manual`，自动任务不得静默移除人工标签。

## 8. TagStudio 迁移与回滚

迁移必须是 **读源、写新库**，不直接修改 `ts_library.sqlite`。

1. 关闭 TagStudio，或从其官方备份/文件副本导入；记录源文件大小、mtime、DB 版本和 SHA-256。
2. 只读打开源库，盘点 `entries`、`tags`、`tag_aliases`、`tag_entries`、字段表及孤儿记录。先生成报告，不写目标。
3. 在临时目标 DB 中一次事务导入；保留所有标签名称、别名和文件关联，并用 `legacy_ids` 保存旧 ID 对照。
4. 相对路径映射到配置的 `root_id`。无法映射、缺失文件、重复路径、重复标签/别名进入报告，不静默丢弃。
5. 校验计数：tag 数、alias 数、entry 数、association 数；抽样对比每个标签的文件集合，并运行 `foreign_key_check`/`integrity_check`。
6. 校验通过后原子切换为正式 DB；原 TagStudio 库保持不变并进入只读冷备阶段。

番号/日期迁移优先级必须在盘点后形成确定规则，例如：明确字段 > 结构化文件名/目录 > 留空。推断值要记录 `source`，不能与人工数据混为一谈。

插件自身 schema 升级流程：启动前用 SQLite backup API 生成带时间戳备份；`BEGIN IMMEDIATE` 中逐版本迁移；成功后更新 `schema_versions`；失败则回滚并拒绝启动写功能。不要用普通文件复制去备份一个正在写入的 DB。

回滚：停止插件 → 将当前 DB 改名保留 → 恢复最近验证过的备份或切回旧插件版本。迁移初期 TagStudio 数据未被修改，因此可以立即回到 TagStudio。切换后若允许在新插件中编辑，回到 TagStudio 会丢失这些新编辑；需要提供只读导出（JSON/CSV + 映射报告），而不是承诺双向同步。

## 9. M1–M4 里程碑

### M1：能力与数据盘点（go/no-go）

- 建最小 Host/Remote/React 骨架，不接生产库。
- 在真实 Windows DSH Desktop 上，用一个测试共享目录验证：默认打开 `.mkv` 进入 PotPlayer、Explorer `/select`、中文/空格/逗号路径、NAS 离线错误。
- 比较两条实现路径：复用 `session.openWorkspacePath` 与 Host 直接使用 `dsh-native-command`；以“只传 media ID、Host 校验路径”为硬约束选择最终方案。
- 对 TagStudio 数据库副本做只读 inventory，确认版本、计数、字段和路径根。
- 产出 ADR：存储位置、Remote 契约、根映射、打开实现。任一 UNC 实机动作不稳定则暂停 M2，先解决 DSH/Windows adapter。

### M2：只读迁移、搜索与打开

- 建本机 SQLite schema、版本迁移、备份。
- 完成 dry-run/import/校验报告，保留旧标签、别名、文件关联。
- UI 支持标签、番号、日期搜索和分页；右键打开/定位。
- 不提供标签编辑，先以生产副本做验收；通过后正式切换只读日常查询。

### M3：标签日常管理，替代 TagStudio

- 标签创建/重命名、别名管理、批量加减标签、合并标签、审计日志与冲突提示。
- 备份/恢复演练，NAS 离线及文件失联状态显示。
- 达成连续使用期（建议两周）后，把 TagStudio 降为冷备，不再日常打开同一库。

### M4：自动入库与演员关联

- 定义 ingestion inbox：消费 DSH Downloader/现有脚本产生的 manifest，而不是猜目录状态。
- manifest 至少含 source ID、临时路径、目标 root/relative path、标题、番号、日期、演员、校验和。
- 先“计划/预览”，经人工确认后移动；移动与 DB 入库用可恢复状态机（planned → moving → indexed → failed），不能假装跨 SMB 文件移动和 SQLite 是一个原子事务。
- `performer_aliases(normalized_name → tag_id)` 规则先生成建议；歧义或新演员进入人工队列。确认后写 `media_tags(source='performer-rule')`。
- 只有出现多 Windows 客户端/后台 NAS ingestion 的真实需求时，才评估 NAS API；保持当前 Repository 接口，使 UI/Remote 不变。

## 10. 测试与验收

### 自动测试

- 数据库：迁移逐版本、失败回滚、外键、唯一约束、tag merge、并发 revision、backup/restore。
- 导入：匿名化 TagStudio fixture 覆盖别名、重复名、孤儿、丢失文件、非 ASCII、旧版本；源库字节不变。
- 搜索：tag name/alias、AND、多日期边界、番号大小写/连字符、稳定分页、NULL 日期。
- 路径：UNC、`..`、盘符注入、根前缀碰撞（`share` vs `share2`）、长路径、逗号/等号/#/%/中文。
- Remote：无效 ID、越权任意路径不可表达、参数上限、取消、错误不泄露凭据/完整路径。
- React：筛选组合、右键菜单、键盘操作、busy/error、无结果。

### Windows/NAS 人工验收

- 真实 `\\NAS\share\...\sample.mkv` 由 Windows 默认关联打开，且进程/窗口确为 PotPlayer。
- Explorer 打开正确目录并选中目标，不只是打开 NAS 根。
- NAS 离线、凭据过期、文件已移动时在 UI 显示可恢复错误，不挂死 Host。
- 10k/100k 级匿名数据的 p95 搜索目标先定为本机 <200 ms（需要根据真实规模校准），UI 首屏 <1 s。
- 迁移报告四项计数与抽样文件集合一致；原 TagStudio DB hash 不变。
- 备份恢复到空目录后，标签、别名、关联和搜索结果一致。

M2 接受标准不是“RPC 返回 200”，而是用户能看到 PotPlayer/Explorer 的正确行为。DSH native-command 自身也把进程交接确认与最终窗口效果区分开来。[官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/util/native-command/README.md#L44-L50)

## 11. DSH bundle 构建与安装

沿用 `dsh-downloader` 的已知形态，而不是发明新的加载方式：

- 源码包包含 Host `src/index.ts`、`src/remote.ts`、Client `src/client/index.ts`、React 组件、locale、`tsconfig`、`tsdown.config.ts`。
- `bundle` 顺序为 TypeScript build → Typert 生成 → tsdown Host/Client bundle。Downloader 当前仍需在 DSH checkout 内生成 Typert 产物，再把 `lib/` 同步到分发 bundle；这是需要复用并逐步消除的约束。[构建脚本](https://github.com/aaeviru/dsh-downloader/blob/d1c44670ef17578b8cd7f0464f20a44bc9b58a02/scripts/build-bundle.sh#L1-L34)
- 分发目录包含 `package.json`、`cordis.patch.yml`、`lib/index.js`、生成的 Typert host/remote、`lib/client.js`、类型和 locale；`dsh.bundle.patch` 指向 `cordis.patch.yml`。[bundle manifest](https://github.com/aaeviru/dsh-downloader/blob/d1c44670ef17578b8cd7f0464f20a44bc9b58a02/bundle/package.json#L1-L51)
- 发布/安装用 `.tgz`，不要以目录 `link:` 作为用户分发；Downloader 的 pack 脚本明确记录目录安装不会解析运行依赖。[pack 脚本](https://github.com/aaeviru/dsh-downloader/blob/d1c44670ef17578b8cd7f0464f20a44bc9b58a02/scripts/pack.sh#L1-L12)
- 数据库和备份不进入 bundle，也不随卸载删除。卸载仅移除插件层。

具体 DSH 版本与 `engines.dsh` 范围应在 M1 钉死；不要把不同 checkout 构建成功当作兼容证据。Host 侧 SQLite 驱动若用原生 addon，会增加 Windows ABI/打包风险；优先选择 DSH/Node 当前可稳定分发的驱动，并在 M1 验证 `.tgz` 冷安装。若无合适现成依赖，再比较纯 JS/WASM SQLite 与小型 NAS API，不能在设计阶段假定原生模块必然可装。

## 12. Issue → PR → CI 工作流

遵循 Downloader 已记录的简化 GitHub Flow：

1. 每个里程碑拆成 Issue Contract，写明问题、可观察验收、允许/禁止修改范围、测试、风险、回退和需人工裁决的歧义。[规范](https://github.com/aaeviru/dsh-downloader/blob/d1c44670ef17578b8cd7f0464f20a44bc9b58a02/docs/development/workflow.md#L13-L32)
2. 从最新 `main` 建短分支；一个 Issue 对应一个主要 PR，不混入 DSH harness 或用户 profile 修改。
3. PR 正文含 Summary、Implementation、Evidence、`[REVIEW]`、Merge Danger；Review 必须绑定完整 commit SHA，且 PR HEAD 必须等于 reviewed commit。[规范](https://github.com/aaeviru/dsh-downloader/blob/d1c44670ef17578b8cd7f0464f20a44bc9b58a02/docs/development/workflow.md#L54-L101)
4. 建立仓库统一 `scripts/verify.sh`：test → typecheck → build/Typert → bundle consistency → packaging；GitHub Actions 只准备环境并调用同一入口，不复制第二套命令。[规范](https://github.com/aaeviru/dsh-downloader/blob/d1c44670ef17578b8cd7f0464f20a44bc9b58a02/docs/development/workflow.md#L104-L143)
5. CI 至少包含 Linux 的纯逻辑门禁和 Windows 的 bundle/SQLite/路径单测；真实 NAS + PotPlayer/Explorer 保留为受控人工或 self-hosted smoke，不伪装成普通云 runner 已验证。
6. 人工决定 merge；Agent 不直接推 `main`、不自行合并。数据库 schema、迁移、构建和 CI 变更均按高风险审查。

建议 Issue 顺序：`M1-host-unc-spike` → `M1-tagstudio-inventory` → `M2-schema-import` → `M2-search-open-ui` → `M3-tag-management` → `M3-backup-restore` → `M4-ingestion-manifest` → `M4-performer-rules`。每个 PR 都可独立回滚。

## 13. 尚未裁决的问题

1. 生产 TagStudio DB 的实际版本、规模、字段模板和根路径是什么？
2. 番号/日期的权威来源是什么；一个番号是否允许多个文件、多个日期？
3. 标签名与别名是否大小写敏感；不同标签能否共享别名；演员同名如何消歧？
4. 媒体库是否只有一个 NAS share；未来是否会增加多个 root？
5. DSH Desktop 运行身份是否与能访问 SMB 的交互式 Windows 用户相同？
6. 当前 DSH profile 使用 `fs-local` 还是远程/SSH filesystem？后者会被 Host 路径映射检查拒绝，这是正确的安全行为。
7. 插件是否需要编辑标题、番号、日期，还是只管理标签？本提案 schema 支持编辑，但 M2 可先只读。
8. 删除标签的语义是禁止、软删除还是彻底删除？建议 M3 默认软归档，合并另走显式事务。
9. 元数据备份的保留期、加密和异机恢复目标是什么？
10. 是否真的有第二个同时写入的客户端？在答案为“是”之前，不应支付 NAS API 的持续运维成本。

## 14. 最终建议

批准 M1 时应明确：**本机 SQLite 是暂定事实源；TagStudio 源只读；SMB SQLite 被排除；NAS API 延后；任何打开动作只由 Host 根据 media ID 和 allowlisted root 生成路径。** M1 只有在真实 NAS 上同时通过默认关联打开和 Explorer 定位后，才进入迁移实现。

这条路线最短，但没有把关键未知数藏起来：DSH 的代码能力已经存在且覆盖 UNC 编码；真正仍需证明的是当前 Desktop 组合、当前 Windows 账户、当前 NAS 和 PotPlayer 关联在这台机器上的端到端行为。

