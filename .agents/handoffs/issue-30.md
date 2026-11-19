# [CONTRACT] Issue #30 v1

Source: https://github.com/aaeviru/dsh-media-library/issues/30 (2026-11-19 specification).
Authority: the user approved the design in this session and explicitly requested `$implement #30`. This file transcribes that scope; its commit is provenance, not independent human approval.
Baseline: 6742403c159dcefed620292762da9d5a0cb3dceb.

## 1. Goal & Scope

Responsive, serialized Host ingestion with default-off EXDEV copying and conservative recovery.
Allowed: ingestion/Host/config/types/Remote/Client modules, versioned SQLite migration, their tests, existing Web verification, version metadata and related documentation.
Forbidden: production NAS/TagStudio data, harness, root lockfiles/configuration, user profile and registry. Queueing and #22 detailed timing logs are excluded.

## 2. Behavior Table

| ID | Behavior | Classification | Evidence |
|---|---|---|---|
| B1 | File operations yield; independent search/status <=500ms during >=5s pending commit/reconcile I/O | INTENTIONAL_CHANGE | sqlite_fixture |
| B2 | Globally serialize commit/reconcile, reject busy with active task, no queue | INTENTIONAL_CHANGE | sqlite_fixture + Web |
| B3 | Freeze executing review/refetch/performer inputs; other entries remain preparable | INTENTIONAL_CHANGE | sqlite_fixture + Web |
| B4 | Normal rename has no content reads; EXDEV copy defaults off, explicit opt-in retains full size/SHA verification | INTENTIONAL_CHANGE | sqlite_fixture |
| B5 | Existing targets compare first/middle/last 1MiB; failures retain source without overwrite | INTENTIONAL_CHANGE | sqlite_fixture |
| B6 | Approved completed move recovers registration idempotently with metadata only | INTENTIONAL_CHANGE | sqlite_fixture |
| B7 | Persist task/phase; reconnect discovers work; restart interrupts, no replay; 30s warning never releases exclusion | INTENTIONAL_CHANGE | sqlite_fixture + Web |
| B8 | Retain human/performer gates, Host path allowlists, short transactions, cleanup/index recovery and database integrity | PARITY_REQUIRED | sqlite_fixture |

All business decisions are resolved by the accepted issue specification. Windows/NAS remains NOT_VERIFIED (linux_env_no_windows_smb).

## 3. Shared Seams & Invariants

Existing MediaLibrarySpikeService methods, temporary SQLite and injectable file-operation adapter; existing Remote/Web cold-install seam. Manifest, task outcome and phase remain distinct. SQLite has one Host owner and stays local. No SMB wait inside a transaction. No Client-controlled copy flag or arbitrary transfer path.

## 4. Risks & Rollback

Door: two-way for code; schema migration is additive and backed up using the existing migration mechanism. Preserve the pre-migration database backup if rolling back to an older schema-aware package. Actual NAS rename/copy semantics require separate Windows observation; local fixtures do not establish throughput improvement.
