# `dsh-media-library` UI & Styling Guidelines (for Coding Agents)

This plugin runs inside DSH Web / Desktop. Follow DSH's styling ownership (`deepseek-harness/docs/web-styling.md`) rather than inventing a second design system.

## 1. Styling & Theming Rules
- **CSS Modules + `--dsw-*` tokens only**: Place component styles in `*.module.css` (compiled by `tsdown.client.ts` via `lightningcss`) and consume semantic `--dsw-alias-*` / `--dsw-specific-*` / `--dsw-elevation-*` tokens so light and dark themes work automatically.
- **No literal colors**: Never write `#hex`, `rgb()`, or `rgba()` colors in `src/client/*.tsx` or `src/client/*.module.css` (enforced by `scripts/verify.sh`).
- **No third-party UI libraries or Tailwind**: Do not add Radix UI, Tailwind, shadcn/ui, or external CSS frameworks. Reuse `@deepseek-ai/dsh-client-ui-primitives` (shared via DSH `PLATFORM_MODULES` at zero plugin bundle cost) through `src/client/ui/primitives.ts`.
- **Hover safety**: Gate `:hover` styles inside `@media (hover: hover)` so touch/hybrid devices stay clean.
- **Inline styles**: Reserve React `style={{ ... }}` strictly for dynamic runtime geometry (e.g., floating context-menu `top`/`left` coordinates).

## 2. Interaction & Navigation Invariants
- **No native `<select>` for tag or performer picking (Issue #28 / #47)**: Always use `src/client/ui/TagPicker.tsx` (searchable, clickable, keyboard-accessible combobox). `scripts/verify.sh` enforces 0 `<select>` tags across `src/client/*.tsx`.
- **Preserve editing state across tab switches (Issue #42)**: Top-level views (`Media Library`, `Pending Ingestion`, `Tag Management`, `Backup & Ops`, `Diagnostics`) switch mutually exclusively via lazy-mount + CSS visibility (`hiddenTab`), never dropping unsaved drafts, filters, or row selections.
- **Keep `data-testid` stable**: Existing `data-testid` attributes verified by `scripts/verify-web.sh` and `scripts/verify-ingestion-web.mjs` are behavioral contracts. Never rename or drop them without an explicit Contract update.
- **Localization**: Every user-visible string belongs in `src/client/locales.ts` (both `en` and `zh`).
