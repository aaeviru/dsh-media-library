---
status: accepted
date: 2026-11-24
issues: ["#17", "#21"]
---

# Acyclic DAG Tag Hierarchy Orthogonal to `tags.kind`

We model tag organization in `dsh-media-library` with two orthogonal concepts: an editable, acyclic directed graph (**Tag Hierarchy**, stored in `tag_parents`) for user-defined multi-parent categories, and a structural **`tags.kind`** enum (`performer`, `seller`, `custom`, `builtin`, `studio`, `series`) for ingestion slots and fixed UI grouping. Selecting a parent tag in search always matches media tagged with that tag or any of its descendants (transitive), without an exact-only UI toggle.

## Considered Options

- **Parent-tag-only classification (no `tags.kind` expansion)**: Simpler single-concept model, but forces M4 metadata ingestion (`actresses` / `writer` / `tags`) and UI grouping to depend on fragile magic parent tag IDs or names that can be renamed, merged, or archived, and conflicts with existing `tags.kind = 'performer'` logic.
- **Single-parent tree instead of DAG**: Simpler cycle rules, but drops edges from the 185 multi-parent relationships already imported from TagStudio.
- **Exact-only toggle in search bar**: Deferred under YAGNI because no immediate daily search workflow needs to exclude descendants when filtering by a parent category.

## Consequences

- Tag edge edits and tag merges (`#5`) must enforce acyclicity inside the write transaction; merges migrate B's edges to A, deduplicate, remove self-loops, and reject with conflict details if a cycle would form.
- Because existing TagStudio libraries already contain legacy parent tags such as `女优`, M5 (`#21`) backfill supports both `performer_aliases` matches and an explicit, previewable parent-tag selection that assigns `tags.kind` to all descendants while leaving the legacy parent tag and its edges intact for optional later cleanup.
