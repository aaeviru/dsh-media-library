# `dsh-media-library` 开发与 Agent 协作工作流规范 v1.0

本规范采用简化的 GitHub Flow，并结合 [brainstorming](https://github.com/aaeviru/brainstorming) 收敛的 **v0.3 迁移型 Agent 协作结论**（Issue Contract、Thin Feature Anchor、Seam Check 证据分级、业务规则检索与行为点级演进），约束本仓库的需求、实现、验证、审查和交付方式；`main` 始终代表稳定基线。

## 1. 核心原则

- **职责分离**：Issue 定义任务边界与业务裁决；PR 承载实现；验证脚本与实机测试提供技术证据；Critic 提供独立审查证据；**人类拥有唯一业务裁决权与合入决定权**。
- **短分支与单向推进**：所有变更从最新 `main` 派生短期分支并通过 PR 返回；Agent 不直接推送 `main`，也不自行合并 PR。一个 Issue 原则上对应一个主要 PR，不引入 `develop`、`release` 等长期分支。
- **诚实标记验证边界**：自动检查只能证明其覆盖的条件。Linux 下的单元测试、匿名 SQLite fixture 测试或 Mock 测试通过，不能替代 Windows DSH Desktop + 真实 NAS SMB + PotPlayer/Explorer 的端到端验收。
- **项目红线（不可违反的不变量）**：
  1. **只读源数据**：严禁修改生产或副本 TagStudio 数据库（`ts_library.sqlite`），导入前后必须校验源库 SHA-256 不变。
  2. **存储位置**：SQLite 数据库必须位于 Windows 本机 DSH 数据目录（如 `%DSH_HOME%/media-library/library.sqlite3`），严禁将在线写入的 SQLite 放在 SMB 共享、插件包目录或 `node_modules` 中。
  3. **Host 唯一可信边界**：Client（React）和 Typert Remote 只传递 `mediaId` / `tagId` 与受控查询参数，严禁接收客户端传入的任意 Windows/UNC 路径；所有路径均由 Host 根据数据库记录与 allowlisted `media_roots` 重建并经 `path.win32` 包含性校验。
  4. **Harness 隔离**：未经 Contract 明确授权，不得修改 `deepseek-harness` workspace、根 lockfile、根 TypeScript 配置、系统注册表或用户个人 profile。

---

## 2. Issue Contract、薄锚点与交接协议

### 2.1 Thin Feature Anchor（父子任务薄锚点）

当某个里程碑或较大任务（如 M1–M4）需要拆分为多个子 Issue 时，不额外维护独立的 Feature Plan 长文档，而是在父 Issue Body 顶部维护 **≤ 15 行的薄锚点（Thin Feature Anchor）**：

1. **端到端业务流**：一句话描述从入口（UI / CLI / 迁移源）到存储或原生动作的完整链路。
2. **跨子 Issue 共享接缝与不变量（Shared Seams & Invariants）**：例如共享的 `root_id + relative_path` 规则、Typert Remote 签名、`revision` 乐观并发字段、或 TagStudio `legacy_ids` 映射约定。
3. **子 Issue 列表与依赖顺序**。

### 2.2 Issue Contract v0

除小型拼写或纯格式修正外，任何代码、Schema、迁移规则、构建或工作流变更前必须先有 **Issue Contract**。

在起草 Contract 前，Agent 必须先检索本仓库已有决策与规则（见第 5 节），并在 Contract 中包含：

```markdown
## [CONTRACT] Issue #<ID> v1

### 1. Goal & Scope
- Goal: <一句话目标>
- Allowed paths: <允许创建/修改的目录与文件>
- Forbidden paths: <明确禁止触碰的目录、生产库、DSH harness 或配置>

### 2. Behavior Table (B1..Bn)
| ID | 行为描述 | 分类 (`PARITY_REQUIRED` / `INTENTIONAL_CHANGE` / `UNRESOLVED`) | 证据要求 (`local_unit_mocked` / `sqlite_fixture` / `windows_smb_e2e`) | 备注或上游规则引用 |
|---|---|---|---|---|
| B1 | ... | PARITY_REQUIRED | sqlite_fixture | Refs #2 |
| B2 | ... | INTENTIONAL_CHANGE | local_unit_mocked + windows_smb_e2e | ... |
| B3 | ... | UNRESOLVED | - | NEEDS_DECISION: ... |

### 3. Shared Seams & Invariants
- <本任务涉及的跨层契约：Host ↔ Typert Remote ↔ React / SQLite Schema / Native Opener>

### 4. Risks & Rollback
- Door: one-way | two-way
- Rollback: <回退步骤>
```

- **执行门禁**：只要 Behavior Table 中存在 `UNRESOLVED`（对应 `NEEDS_DECISION`），Worker 不得擅自编写猜测性的实现代码，必须等待人类在 Issue 中给出 `[DECISION]`。
- **范围约束**：发现范围外问题时，Worker 应记录并交回人类或 Orchestrator，不得以“顺手修复”为由扩大 PR。

### 2.3 工作区交接文件与授权边界（Git SHA vs 人工批准）

当多 Agent 跨会话交接或工作环境不便频繁写入长评论时，可将当前 Issue 的 Contract 与交接状态同步保存在仓库内：

```text
.agents/handoffs/issue-<N>.md
```

**版本追溯与可信授权严格区分**：
1. **Git Commit SHA 只提供版本追溯，不等于可信授权**：因为 Worker 同样拥有仓库文件写权限，Agent 生成或提交 `.agents/handoffs/issue-<N>.md` 仅代表候选版本。
2. **只有人类明确批准的固定版本才是有效执行依据**：人类在 Issue 评论中记录（如 `[DECISION] APPROVE CONTRACT v1 @ <commit-SHA>`）后，该版本才生效。
3. **防篡改核对**：Critic 在审查 PR 时，必须核对当前分支的 `.agents/handoffs/issue-<N>.md` 相对于人类批准 SHA 是否发生未授权变更（`git diff <approved-SHA>..HEAD -- .agents/handoffs/issue-<N>.md`）。

### 2.4 分支命名

所有任务分支从最新 `main` 派生，PR 合并后删除：

| 类型 | 命名 | 示例 |
| --- | --- | --- |
| 新功能 / 里程碑实现 | `feat/<issue>-<slug>` | `feat/1-host-unc-spike` |
| Bug 修复 | `fix/<issue>-<slug>` | `fix/4-keyset-cursor` |
| 重构 | `refactor/<issue>-<slug>` | `refactor/3-import-tx` |
| 文档与规范 | `docs/<issue>-<slug>` 或 `docs/<slug>` | `docs/workflow-and-labels` |
| 工具、构建、CI、流程 | `chore/<issue>-<slug>` | `chore/2-inventory-fixture` |

---

## 3. 验证门禁与 Seam Check 证据分级

### 3.1 统一验证入口（`./scripts/verify.sh`）

自 M1 建立代码骨架起，本地 Worker 与 GitHub Actions 必须调用同一个仓库验证入口：

```sh
./scripts/verify.sh
```

按里程碑演进，该脚本按固定顺序覆盖：

1. **Test**：单元测试、路径安全边界测试、匿名化 TagStudio SQLite fixture 导入与搜索测试。
2. **Typecheck**：Host、Client 及测试类型检查。
3. **Build**：编译、Typert 生成、Host/Client bundle。
4. **Bundle consistency**：重新生成后，检查入库产物与源码一致且无未提交差异。
5. **Packaging**：`.tgz` 打包、manifest、`cordis.patch.yml`、入口与 locale 完整性核对。

### 3.2 Seam Check（接缝检查）与证据分级

为防止“局部单测全绿，但跨层字段失配或实机打不开文件”的假阳性，所有 `[VERIFY]` 与 `[REVIEW]` 报告必须区分以下两级证据：

1. **局部行为证据（Local Behavior Status）**：
   - `VERIFIED (scope: local_unit_mocked)`：纯逻辑或 Mock 单元测试通过（如 Linux 下跑 `path.win32` UNC 规范化与防越界测试、React 组件状态测试）。
   - `VERIFIED (scope: sqlite_fixture)`：基于匿名化 SQLite 样本库的真实 SQL/迁移/盘点测试通过。
2. **跨层与实机接缝证据（`seam_status`）**：
   - **Host ↔ Remote ↔ Client 接缝**：Typert 契约参数/返回值、错误码与 `revision` 乐观并发字段在三端严格对齐。
   - **SQLite ↔ TagStudio 源库接缝**：源库 SHA-256 未变、`legacy_ids` 对照完整、`foreign_key_check` 与 `integrity_check` 通过。
   - **Windows DSH Desktop ↔ NAS SMB ↔ Native Opener 接缝（`windows_smb_e2e`）**：在真实 Windows DSH Desktop 中冷安装 `.tgz`，对真实 SMB 共享执行默认打开（拉起 PotPlayer）与 Explorer `/select` 定位。
   - 在 Linux 开发环境或未连接真实 NAS 的环境中，`windows_smb_e2e` 必须诚实标记为 `NOT_VERIFIED (reason: linux_env_no_windows_smb)`，严禁将“命令拼接单测通过”报告为端到端已验证。

---

## 4. PR 与绑定 SHA 的 `[REVIEW]`

### 4.1 PR 最低内容

```markdown
## Summary

<最小文件树、流程图或差异摘要>

Refs #<ID>（若完成该 Issue 全部交付且包含所需实机验收，才使用 Closes #<ID>）

## Implementation

- <做了什么（对应 Contract B1..Bn）>
- <明确未做什么>

## Evidence & Seam Check

- Local Verification: `PASS | FAIL | NOT RUN`（命令与输出摘要）
- Behavior Evidence:
  - `B1`: `VERIFIED (scope: ...)`
- Seam Check (`seam_status`):
  - Host ↔ Remote ↔ Client: `VERIFIED | NOT_VERIFIED | N/A`
  - SQLite / Migration Integrity: `VERIFIED | NOT_VERIFIED | N/A`
  - Windows Desktop + SMB E2E: `VERIFIED | NOT_VERIFIED (reason: ...)`

## [REVIEW]

Status: PENDING | PASS | FAIL
Critic: <身份>
Reviewed commit: <完整 commit SHA>
Contract SHA Check: <若使用 .agents/handoffs/issue-N.md，核对与批准版本是否一致>
Evidence: <PR Review 永久链接或审查记录>

## Merge Danger

Door: one-way | two-way
Blast Radius: <影响范围>
Risks / Rollback: <风险与回退方式>
```

### 4.2 Review 必须绑定实际 Commit SHA

- `[REVIEW]` 必须记录被审查的完整 commit SHA。Worker 推送新提交后，旧 SHA 的 `PASS` 自动失效，Critic 必须审查增量差异并更新绑定 SHA。
- Issue 评论中的方案讨论属于 **Issue Review**，不能替代针对实际代码 diff 和验证证据的 **PR Review**。

---

## 5. 业务规则检索、沉淀与防过度泛化（`brainstorming` #3/#4 落地）

在从 TagStudio 迁移数据与构建媒体库规则的过程中，按以下机制管理业务知识：

### 5.1 最小 GitHub Labels 体系

仓库使用固定标签集支持 Agent 在起草 Contract 前按标签过滤历史决策：

- **业务域（`area/*`，共 5 个）**：
  - `area/host-unc`：DSH Host、UNC 路径安全解析、Windows 默认应用打开与 Explorer 定位
  - `area/tagstudio-import`：TagStudio 只读盘点、无损导入规则、`legacy_ids` 映射
  - `area/sqlite-schema`：本机 SQLite Schema、版本迁移、备份/恢复与完整性校验
  - `area/search-ui`：React 搜索界面、Typert Remote 契约、分页与状态展示
  - `area/tag-ingestion`：标签/别名增删改合、Manifest 审核入库与演员规则关联
- **性质（`type/*`）**：
  - `type/contract`：受 Issue Contract 约束的开发或盘点任务
  - `type/decision`：包含人类已拍板的业务或架构裁决（`[DECISION]`）
  - `type/rule`：包含可复用的业务规则或不变量（`[RULE]`）
- **状态（`status/*`）**：
  - `status/needs-decision`：存在 `UNRESOLVED` 歧义或 M1 go/no-go 门禁待人类裁决
  - `status/approved`：Contract 或核心裁决已获人类批准
  - `status/verified`：代码验证与所要求的实机/集成验收均已完成

### 5.2 开工前两步检索

起草新 Issue Contract 前，Agent 必须先检索同域历史决策：

```sh
gh issue list --repo aaeviru/dsh-media-library --state all --label "area/<domain>" --label "type/decision"
gh issue list --repo aaeviru/dsh-media-library --state all --label "area/<domain>" --search "[DECISION] OR [RULE]"
```

### 5.3 高风险规则的 `boundary_not_covered`（防过度泛化）

在记录高风险业务规则（如 UNC 路径白名单、番号/日期提取优先级、标签大小写与共享别名合并语义）时，除写明 `applies_to` 外，显式写一行 `boundary_not_covered`：

```markdown
[RULE] <规则标题>
- applies_to: <明确适用的范围与前置条件>
- rule: <确定性规则>
- boundary_not_covered: <本条规则未覆盖的相邻场景>
- source: Issue #<ID> / B<k>
```

**命中 `boundary_not_covered` 时的行为准则**：
- `boundary_not_covered` 表示 **`NOT_COVERED`（该条历史规则无法回答当前问题）**，**不等于直接触发人工审批**。
- Agent 命中 `boundary_not_covered` 后，必须先检索其他已批准规则或检查源码/只读样本库；只有在检索后确认仍无有效规则覆盖时，才将其列为 `NEEDS_DECISION` 交由人类裁决。

### 5.4 行为点级失效（`[SUPERSEDED]`）与文档晋升信号

1. **按行为点（`B1..Bn`）追踪失效，不整张废止 Issue**：
   - 当新决策推翻旧 Issue 中的某条行为规则时，在新 `[DECISION]` 中写明：`supersedes: Issue #<old> / B<k>`。
   - 同时在旧 Issue 对应处追加反向引用：`[SUPERSEDED] B<k> -> Issue #<new> / B<m>`，保留该旧 Issue 中其余仍有效的行为点。
2. **何时将 Issue 决策晋升到 `docs/design.md` 或 ADR（三类高优先级候选信号）**：
   - 默认不维护庞大的独立规则库；当某项业务决策属于 **(a) 反直觉判例**、**(b) 跨模块/跨里程碑不变量**、或 **(c) 在多个 Issue 中反复出现的单模块特殊异常规则** 时，应在 PR 中同步更新 [docs/design.md](../design.md) 或 `docs/adr/`。

---

## 6. Agent 工作边界与并行 Worktree

- **Worktree 隔离**：多个 Agent 或并行任务写入本仓库时，每个任务分支必须使用独立的 Git Worktree（例如 `/tmp/dsh-media-library-<issue>` 或平级 `worktree-<issue>`），主工作树 `/home/aaevi/projects/dsh-media-library` 保持在干净的 `main` 基线用于只读核对与规划。
- **分支清理**：PR 合并后，先将主工作树 `main` fast-forward 到最新 `origin/main`，确认提交已包含且无未提交工作后，立即移除对应的临时 Worktree 与本地分支。
