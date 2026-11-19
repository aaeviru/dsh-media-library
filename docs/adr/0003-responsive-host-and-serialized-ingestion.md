# ADR 0003: Responsive Host and Serialized Ingestion

- **Status**: Accepted design (user decisions, 2026-11-19); implementation tracked by Issue #30.
- **Refs**: [#30](https://github.com/aaeviru/dsh-media-library/issues/30), [#22](https://github.com/aaeviru/dsh-media-library/issues/22), [#37](https://github.com/aaeviru/dsh-media-library/issues/37), [ADR 0002](0002-staging-scan-and-move.md).

## Context

Synchronous SMB probes, moves and content reads blocked independent Host queries. Making RPC methods async did not change synchronous file I/O. Existing EXDEV fallback silently copied multi-GB videos. A file operation can complete even if its response or subsequent catalog registration fails, so waiting warnings must not release execution exclusion.

## Decision

Use asynchronous file operations with SQLite owned by the Host. Keep connections alive across awaits, without holding a transaction during NAS I/O. Persist the Ingestion Task and its current Ingestion Phase separately. One commit or reconcile changes files at a time; competing execution is rejected with the active task, without queueing. Freeze the executing Manifest's review/refetch/performer inputs, while other entries remain preparable. Tag merges that would rewrite those frozen references are also rejected.

Ordinary rename uses destination metadata verification without content reads. Host `allowCrossDeviceCopy` defaults to false; only explicit opt-in plus EXDEV allows copy, with full source/destination size and SHA-256 verification before indexing and source cleanup. Non-EXDEV errors do not trigger copy. This setting does not affect database backups.

When both source and an existing same-name/same-size destination remain, compare identical first, centered middle and last 1 MiB ranges (merge overlapping ranges for small files). This reads at most 6 MiB in total. Mismatch, short read or read failure preserves the source and blocks reuse; no automatic overwrite/recopy follows. The accepted comparison does not establish full-file equality.

When an approved move has no remaining staging source, a planned destination with matching filename and size suffices to finish catalog registration idempotently after Host path validation. Completed-Move Recovery does not transfer, sample or hash again. Missing/mismatching targets remain unresolved. Preserve copied-not-deleted and indexed-but-missing recovery and visible cleanup failures.

Execution belongs to the Host and survives UI disconnection while the Host remains alive. Replacing a service within the same Host preserves process-local ownership of still-active I/O; constructing a new service is not proof of a Host restart. Admission is process-wide even when replacement changes the configured local database. A true Host restart has no live operation ownership, marks outstanding tasks interrupted and requires explicit recovery. After 30 seconds without a phase change, display a waiting warning; no synthetic percentages, automatic cancellation, retry or lock release. This version has no byte-progress reporting and no immediate cancellation.

## Consequences

Responsiveness is tested independently: search and task-status queries each finish within 500 ms during a file operation held pending for at least five seconds. Controlled local filesystem/SQLite and cold-installed Remote/Web evidence do not establish real Windows/SMB behavior or reduced total ingestion latency.

Issue #22 will add ordinary-use phase/total timings and detailed elapsed-time presentation through the same task contract. It does not require a dedicated throughput benchmark. Queueing remains future work in #37. Schema v7 adds phase fields through the existing backed-up migration mechanism, without a queue table.
