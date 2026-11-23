# Media Library Glossary

- **Media Root**: An allowlisted NAS share root where media files live.
- **Staging Folder (`temp`)**: A directory inside the NAS holding video files waiting for tag review and filing.
- **Staging Scan**: Listing video files currently in the Staging Folder using directory and file metadata only, without reading file contents or recording unreviewed entries.
- **Ingestion Manifest**: A durable record created only when a human starts acting on a staged file (fetching tags, reviewing, moving, or recovering a failure).
- **Ingestion Task**: A durable progress record (`running`, `succeeded`, `failed`, `interrupted`) for slow staging actions (metadata fetch, move/index, reconcile) that prevents duplicate concurrent runs and survives UI unmounts.
- **Ingestion Phase**: The named step currently being executed within an Ingestion Task, distinct from that task's running or final outcome.
- **Existing-Target Quick Check**: Comparing the source and an existing same-name/same-size destination at identical beginning, centered middle, and ending ranges before reusing the destination and cleaning up the source. This is a bounded sample comparison, not whole-file equality verification.
- **Completed-Move Recovery**: Finishing catalog registration for an approved move whose staging source is absent and whose planned destination metadata matches the Manifest, without transferring or reading its content again.
- **Human Review Gate**: The explicit approval step confirming tags and metadata before any file is moved or indexed.
- **Recoverable Move**: Moving a reviewed file from the Staging Folder to the fixed target folder inside the NAS, then recording it in the local catalog and cleaning up a remaining source only after verified copy or accepted existing-target reuse.
- **Reconcile**: Repairing interrupted ingestion states (`copied-not-deleted`, `moved-not-indexed`, `indexed-but-missing`) after a crash or network drop.
- **Performer Alias**: An explicit mapping from a normalized source performer name to a target tag, either resolving automatically (`auto`) when unique or always prompting (`always_ask`) for shared/ambiguous stage names.
- **Performer Review Queue**: The human decision queue for unknown, ambiguous, or archived-target performer names so automation never silently guesses or creates performer tags.
- **Cold Fallback**: Keeping the original TagStudio database read-only and untouched as an archive after cutover.
- **Read-Only Degraded Mode**: A protective state where writes and moves are blocked due to schema or integrity mismatch while search and exports stay available.
- **Tag Hierarchy**: An acyclic directed graph (DAG) of parent-child relationships organizing tags into categories, where selecting a parent tag in search transitively matches media carrying the tag or any of its descendants.
- **Tag Kind**: The structural role of a tag (`performer`, `seller`, `custom`, `builtin`, `studio`, `series`), orthogonal to its parent categories in the Tag Hierarchy.
- **Staging Soft Delete**: Moving an unindexed video out of the Staging Folder into an isolated same-share `.trash` directory via atomic rename, removing its unindexed Manifest while recording an audit entry.
