# dsh-media-library

A Windows-first DSH Desktop plugin for managing and searching a Synology NAS media library.

## Status

Design and validation phase. No production media or TagStudio database should be modified until the M1 Windows/UNC spike and the migration dry-run have passed.

## Scope

- Preserve and manage existing tags, aliases, and file associations.
- Search by tag, catalog number, and date.
- Open NAS SMB originals with the Windows default application.
- Reveal the selected file in Windows Explorer.
- Later integrate reviewed ingestion and performer-tag association.

Out of scope: embedded playback, transcoding, thumbnails, and Synology Photos.

## Proposed architecture

The initial architecture is a Windows DSH Desktop plugin (React + Typert Remote + Host) with a local SQLite database. NAS stores the original media files. SQLite must not be opened directly over SMB. A NAS-side database/API is deferred until there is a real second writer.

See [the detailed design](docs/design.md).

## Delivery plan

Work is divided into M1-M4 GitHub issues. Start with the M1 Host/UNC spike; do not begin production migration before that issue passes.

## References

- [dsh-downloader](https://github.com/aaeviru/dsh-downloader)
- [dsh-plugin-docs](https://github.com/aaeviru/dsh-plugin-docs)
- [TagStudio](https://github.com/TagStudioDev/TagStudio)
