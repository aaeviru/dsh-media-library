# Media Library Glossary

- **Media Root**: An allowlisted NAS share root where media files live.
- **Staging Folder (`temp`)**: A directory inside the NAS holding video files waiting for tag review and filing.
- **Staging Scan**: Listing video files currently in the Staging Folder using directory and file metadata only, without reading file contents or recording unreviewed entries.
- **Ingestion Manifest**: A durable record created only when a human starts acting on a staged file (fetching tags, reviewing, moving, or recovering a failure).
- **Ingestion Task**: A durable progress record (`running`, `succeeded`, `failed`, `interrupted`) for slow staging actions (metadata fetch, move/index, reconcile) that prevents duplicate concurrent runs and survives UI unmounts.
- **Human Review Gate**: The explicit approval step confirming tags and metadata before any file is moved or indexed.
- **Recoverable Move**: Moving a reviewed file from the Staging Folder to the fixed target folder inside the NAS, then recording it in the local catalog and cleaning up the source only if copied across volumes.
- **Reconcile**: Repairing interrupted ingestion states (`copied-not-deleted`, `moved-not-indexed`, `indexed-but-missing`) after a crash or network drop.
- **Cold Fallback**: Keeping the original TagStudio database read-only and untouched as an archive after cutover.
- **Read-Only Degraded Mode**: A protective state where writes and moves are blocked due to schema or integrity mismatch while search and exports stay available.
