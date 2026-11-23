# `dsh-media-library` Agent Navigation

Windows-first DSH Desktop plugin (`@deepseek-ai/dsh-experimental-media-library`) for a Synology NAS media library.

## Context Pointers

- **Workflow, Contracts, PR template, and worktrees**: Read [docs/development/workflow.md](docs/development/workflow.md) before drafting an Issue Contract, opening a PR, or packaging `.tgz`.
- **Review-stage judgement rules**: Read [CODING_STANDARDS.md](CODING_STANDARDS.md) during Critic / PR review (not required during initial exploration).
- **Client UI work (`src/client/`)**: Read [docs/ui-guidelines.md](docs/ui-guidelines.md) before editing React components or styles.
- **Domain vocabulary**: Check [GLOSSARY.md](GLOSSARY.md) when naming concepts, UI labels, or RPC fields.
- **Architecture & operations**: Consult [docs/adr/](docs/adr/) and [docs/operations-and-recovery.md](docs/operations-and-recovery.md) for current invariants (`docs/design.md` is historical M1–M4 baseline).

## Environment Gotcha

- In a fresh Git worktree, run `./scripts/build-bundle.sh` once before running `node --experimental-strip-types --test ...` so local `node_modules` symlinks to `../deepseek-harness` are initialized.
- Run `./scripts/verify.sh` as the single 5-stage verification gate before committing or opening a PR.
