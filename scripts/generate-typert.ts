import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const LIB_DIR = path.join(REPO_ROOT, 'lib');


// ---- Issue #5 tag / alias management metadata (generated from compact tables) ----
const MUTATION_ERROR_CODES = [
  'INVALID_INPUT',
  'TAG_NOT_FOUND',
  'MEDIA_NOT_FOUND',
  'REVISION_CONFLICT',
  'TAG_NAME_CONFLICT',
  'ALIAS_CONFLICT',
  'ALIAS_NOT_FOUND',
  'BATCH_TOO_LARGE',
  'TAG_IN_USE',
  'MERGE_WOULD_CREATE_CYCLE',
  'TAG_ARCHIVED',
  'TAG_NOT_ARCHIVED',
  'INTERNAL_ERROR',
];
const codeUnion = `z.union([${MUTATION_ERROR_CODES.map(c => `z.literal('${c}')`).join(', ')}]).readonly()`;

function zObject(fields: Record<string, string>): string {
  return `z.object({ ${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join(', ')} })`;
}

const NUM = 'z.number().readonly()';
const STR = 'z.string().readonly()';
const BOOL = 'z.boolean().readonly()';

const MUTATION_ERROR_SCHEMA = zObject({
  ok: 'z.literal(false).readonly()',
  code: codeUnion,
  message: STR,
  failures: `z.array(${zObject({
    mediaId: 'z.string().nullable().readonly()',
    tagId: 'z.number().nullable().readonly()',
    code: codeUnion,
    message: STR,
  })}).readonly()`,
});

interface MutationSchemaSpec {
  readonly key: string; // schema name suffix
  readonly fields: Record<string, string>;
}
const MUTATION_INPUTS: MutationSchemaSpec[] = [
  { key: 'createTagInput', fields: { name: STR } },
  { key: 'renameTagInput', fields: { tagId: NUM, name: STR, expectedRevision: NUM } },
  { key: 'aliasInput', fields: { tagId: NUM, alias: STR, expectedRevision: NUM } },
  { key: 'tagRevisionInput', fields: { tagId: NUM, expectedRevision: NUM } },
  {
    key: 'setMediaTagsInput',
    fields: {
      mediaIds: 'z.array(z.string()).readonly()',
      addTagIds: 'z.array(z.number()).optional().readonly()',
      removeTagIds: 'z.array(z.number()).optional().readonly()',
      expectedMediaRevisions: `z.array(${zObject({ mediaId: STR, revision: NUM })}).optional().readonly()`,
    },
  },
  { key: 'previewMergeInput', fields: { targetTagId: NUM, sourceTagId: NUM } },
  {
    key: 'mergeTagsInput',
    fields: { targetTagId: NUM, sourceTagId: NUM, expectedTargetRevision: NUM, expectedSourceRevision: NUM },
  },
];
const MUTATION_RESULTS: MutationSchemaSpec[] = [
  { key: 'tagMutationResult', fields: { ok: 'z.literal(true).readonly()', tagId: NUM, revision: NUM, mutationId: NUM } },
  {
    key: 'setMediaTagsResult',
    fields: { ok: 'z.literal(true).readonly()', mutationId: NUM, mediaCount: NUM, added: NUM, removed: NUM, unchanged: NUM },
  },
  {
    key: 'mergePreviewResult',
    fields: {
      ok: 'z.literal(true).readonly()',
      targetTagId: NUM,
      sourceTagId: NUM,
      targetRevision: NUM,
      sourceRevision: NUM,
      affectedMedia: NUM,
      dedupedMedia: NUM,
      aliasesMigrated: NUM,
      aliasesConflicting: NUM,
      parentEdgesMigrated: NUM,
      parentEdgesDeduped: NUM,
      wouldCreateCycle: BOOL,
    },
  },
  {
    key: 'mergeTagsResult',
    fields: {
      ok: 'z.literal(true).readonly()',
      mutationId: NUM,
      targetTagId: NUM,
      targetRevision: NUM,
      sourceTagId: NUM,
      sourceRevision: NUM,
      migratedMediaTags: NUM,
      dedupedMediaTags: NUM,
      aliasesMigrated: NUM,
      aliasesDropped: NUM,
      parentEdgesMigrated: NUM,
    },
  },
];

const MUTATION_SCHEMAS = [
  `const _mediaLibrary_mutationError = () => ${MUTATION_ERROR_SCHEMA}`,
  ...MUTATION_INPUTS.map(
    i => `let _mediaLibrary_${i.key}$schema$value\nconst _mediaLibrary_${i.key}$schema = () => (_mediaLibrary_${i.key}$schema$value ??= ${zObject(i.fields)})`,
  ),
  ...MUTATION_RESULTS.map(
    r =>
      `let _mediaLibrary_${r.key}$schema$value\nconst _mediaLibrary_${r.key}$schema = () => (_mediaLibrary_${r.key}$schema$value ??= z.union([${zObject(r.fields)}, _mediaLibrary_mutationError()]))`,
  ),
  `let _mediaLibrary_createBackupInput$schema$value\nconst _mediaLibrary_createBackupInput$schema = () => (_mediaLibrary_createBackupInput$schema$value ??= z.object({ reason: z.enum(['manual', 'daily']).readonly().optional() }).readonly().optional())`,
  `let _mediaLibrary_createBackupResult$schema$value\nconst _mediaLibrary_createBackupResult$schema = () => (_mediaLibrary_createBackupResult$schema$value ??= z.object({ ok: ${BOOL}, backupPath: ${STR}.optional(), sha256: ${STR}.optional(), size: ${NUM}.optional(), prunedCount: ${NUM}.optional(), nasCopyPath: ${STR}.nullable().optional(), nasCopyWarning: ${STR}.nullable().optional(), error: ${STR}.optional() }).readonly())`,
  `let _mediaLibrary_exportMappingReportInput$schema$value\nconst _mediaLibrary_exportMappingReportInput$schema = () => (_mediaLibrary_exportMappingReportInput$schema$value ??= z.object({ format: z.enum(['json', 'csv']).readonly() }).readonly())`,
  `let _mediaLibrary_exportMappingReportResult$schema$value\nconst _mediaLibrary_exportMappingReportResult$schema = () => (_mediaLibrary_exportMappingReportResult$schema$value ??= z.object({ ok: ${BOOL}, format: z.enum(['json', 'csv']).readonly(), filename: ${STR}, mimeType: ${STR}, rowCount: ${NUM}, sha256: ${STR}, content: ${STR}, error: ${STR}.optional() }).readonly())`,
  `let _mediaLibrary_opsStatus$schema$value\nconst _mediaLibrary_opsStatus$schema = () => (_mediaLibrary_opsStatus$schema$value ??= z.object({ localDataDir: ${STR}, localDatabasePath: ${STR}, backupDir: ${STR}, nasBackupDir: ${STR}.nullable(), dailyRetentionCount: ${NUM}, preMigrateRetentionCount: ${NUM}, autoDailyBackup: ${BOOL}, lastAutoBackupAt: ${STR}.nullable(), lastBackupSha256: ${STR}.nullable(), degradedState: z.object({ degraded: ${BOOL}, reason: ${STR}.nullable(), schemaVersion: ${NUM}, supportedMaxVersion: ${NUM}, healthOk: ${BOOL}, checkedAt: ${STR} }).readonly(), backups: z.array(z.object({ filename: ${STR}, path: ${STR}, kind: z.enum(['daily', 'pre-migrate']).readonly(), size: ${NUM}, mtimeIso: ${STR} }).readonly()).readonly() }).readonly())`,
  `let _mediaLibrary_ingestionTag$schema$value\nconst _mediaLibrary_ingestionTag$schema = () => (_mediaLibrary_ingestionTag$schema$value ??= z.object({ tagId: ${NUM}.optional(), name: ${STR} }).readonly())`,
  `let _mediaLibrary_ingestionManifest$schema$value\nconst _mediaLibrary_ingestionManifest$schema = () => (_mediaLibrary_ingestionManifest$schema$value ??= z.object({ id: ${NUM}, sourceId: ${STR}, tempPath: ${STR}, targetRootId: ${STR}, targetRelativePath: ${STR}, filename: ${STR}, title: ${STR}.nullable(), catalogNumber: ${STR}.nullable(), mediaDate: ${STR}.nullable(), tags: z.array(_mediaLibrary_ingestionTag$schema()).readonly(), metadataSource: ${STR}.nullable(), checksumSha256: ${STR}, fileSize: ${NUM}, state: z.enum(['planned', 'reviewed', 'moving', 'indexed', 'failed']).readonly(), reviewDecision: z.enum(['pending', 'approved', 'rejected']).readonly(), lastError: ${STR}.nullable(), indexedMediaId: ${NUM}.nullable(), createdAt: ${STR}, updatedAt: ${STR} }).readonly())`,
  `let _mediaLibrary_ingestionManifestList$schema$value\nconst _mediaLibrary_ingestionManifestList$schema = () => (_mediaLibrary_ingestionManifestList$schema$value ??= z.array(_mediaLibrary_ingestionManifest$schema()).readonly())`,
  `let _mediaLibrary_scanStagingResult$schema$value\nconst _mediaLibrary_scanStagingResult$schema = () => (_mediaLibrary_scanStagingResult$schema$value ??= z.object({ ok: ${BOOL}, stagingDir: ${STR}, targetRootId: ${STR}, targetSubdir: ${STR}, elapsedMs: ${NUM}, files: z.array(z.object({ filename: ${STR}, relativePath: ${STR}, tempPath: ${STR}, targetRelativePath: ${STR}, fileSize: ${NUM}, mtimeIso: ${STR}, catalogNumber: ${STR}.nullable(), manifestId: ${NUM}.nullable(), state: z.enum(['planned', 'reviewed', 'moving', 'indexed', 'failed']).nullable(), reviewDecision: z.enum(['pending', 'approved', 'rejected']).nullable() }).readonly()).readonly(), manifests: _mediaLibrary_ingestionManifestList$schema(), error: ${STR}.optional() }).readonly())`,
  `let _mediaLibrary_fetchIngestionMetadataInput$schema$value\nconst _mediaLibrary_fetchIngestionMetadataInput$schema = () => (_mediaLibrary_fetchIngestionMetadataInput$schema$value ??= z.object({ manifestId: ${NUM}.optional(), tempPath: ${STR}.optional() }).readonly())`,
  `let _mediaLibrary_fetchedMetadataCandidate$schema$value\nconst _mediaLibrary_fetchedMetadataCandidate$schema = () => (_mediaLibrary_fetchedMetadataCandidate$schema$value ??= z.object({ ok: ${BOOL}, provider: ${STR}.nullable(), category: ${STR}, reason: ${STR}, sourceUrl: ${STR}, title: ${STR}.nullable(), writer: ${STR}.nullable(), candidateTags: z.array(${STR}).readonly(), manifest: _mediaLibrary_ingestionManifest$schema().nullable() }).readonly())`,
  `let _mediaLibrary_reviewIngestionInput$schema$value\nconst _mediaLibrary_reviewIngestionInput$schema = () => (_mediaLibrary_reviewIngestionInput$schema$value ??= z.object({ manifestId: ${NUM}.optional(), tempPath: ${STR}.optional(), decision: z.enum(['approved', 'rejected']).readonly(), title: ${STR}.optional(), catalogNumber: ${STR}.optional(), mediaDate: ${STR}.optional(), tagIds: z.array(${NUM}).readonly().optional(), newTagNames: z.array(${STR}).readonly().optional() }).readonly())`,
  `let _mediaLibrary_reviewIngestionResult$schema$value\nconst _mediaLibrary_reviewIngestionResult$schema = () => (_mediaLibrary_reviewIngestionResult$schema$value ??= z.object({ ok: ${BOOL}, code: ${STR}.optional(), message: ${STR}.optional(), manifest: _mediaLibrary_ingestionManifest$schema().nullable().optional() }).readonly())`,
  `let _mediaLibrary_commitIngestionInput$schema$value\nconst _mediaLibrary_commitIngestionInput$schema = () => (_mediaLibrary_commitIngestionInput$schema$value ??= z.object({ manifestId: ${NUM} }).readonly())`,
  `let _mediaLibrary_commitIngestionResult$schema$value\nconst _mediaLibrary_commitIngestionResult$schema = () => (_mediaLibrary_commitIngestionResult$schema$value ??= z.object({ ok: ${BOOL}, code: ${STR}.optional(), message: ${STR}, idempotentReplay: ${BOOL}.optional(), mediaId: ${NUM}.nullable().optional(), warning: ${STR}.nullable().optional(), manifest: _mediaLibrary_ingestionManifest$schema().nullable().optional() }).readonly())`,
  `let _mediaLibrary_reconcileIngestionResult$schema$value\nconst _mediaLibrary_reconcileIngestionResult$schema = () => (_mediaLibrary_reconcileIngestionResult$schema$value ??= z.object({ ok: ${BOOL}, reconciledCount: ${NUM}, copiedNotDeletedFixed: ${NUM}, movedNotIndexedFixed: ${NUM}, indexedButMissingMarked: ${NUM}, errors: z.array(${STR}).readonly(), manifests: _mediaLibrary_ingestionManifestList$schema() }).readonly())`,
].join('\n\n');

interface MutationMethodSpec {
  readonly name: string;
  readonly description: string;
  readonly inputKey: string;
  readonly inputType: string;
  readonly resultKey: string;
  readonly resultType: string;
  readonly paramDescription: string;
  readonly line: number;
}
const MUTATION_METHODS: MutationMethodSpec[] = [
  { name: 'createTag', description: 'Create a custom tag (name is trimmed; normalized-name collisions return TAG_NAME_CONFLICT).', inputKey: 'createTagInput', inputType: 'CreateTagInput', resultKey: 'tagMutationResult', resultType: 'TagMutationResult', paramDescription: 'New tag name.', line: 112 },
  { name: 'renameTag', description: 'Rename a tag using optimistic revision checking.', inputKey: 'renameTagInput', inputType: 'RenameTagInput', resultKey: 'tagMutationResult', resultType: 'TagMutationResult', paramDescription: 'Tag id, new name and expected revision.', line: 120 },
  { name: 'addAlias', description: "Add an alias to a tag; clashes with other tags' names or aliases return ALIAS_CONFLICT.", inputKey: 'aliasInput', inputType: 'AliasInput', resultKey: 'tagMutationResult', resultType: 'TagMutationResult', paramDescription: 'Tag id, alias text and expected revision.', line: 128 },
  { name: 'removeAlias', description: 'Remove an alias from a tag using optimistic revision checking.', inputKey: 'aliasInput', inputType: 'AliasInput', resultKey: 'tagMutationResult', resultType: 'TagMutationResult', paramDescription: 'Tag id, alias text and expected revision.', line: 136 },
  { name: 'setMediaTags', description: 'Atomically add and/or remove tags on up to 200 media items by mediaId and tagId.', inputKey: 'setMediaTagsInput', inputType: 'SetMediaTagsInput', resultKey: 'setMediaTagsResult', resultType: 'SetMediaTagsResult', paramDescription: 'Media ids, tag ids to add and remove.', line: 144 },
  { name: 'previewMerge', description: 'Read-only impact preview of merging tag B (source) into tag A (target).', inputKey: 'previewMergeInput', inputType: 'PreviewMergeInput', resultKey: 'mergePreviewResult', resultType: 'MergePreviewResult', paramDescription: 'Target (A) and source (B) tag ids.', line: 152 },
  { name: 'mergeTags', description: 'Merge tag B (source) into tag A (target) atomically; B is archived, never deleted.', inputKey: 'mergeTagsInput', inputType: 'MergeTagsInput', resultKey: 'mergeTagsResult', resultType: 'MergeTagsResult', paramDescription: 'Target and source tag ids with the previewed revisions.', line: 160 },
  { name: 'archiveTag', description: 'Archive a tag non-destructively (existing associations and search stay readable).', inputKey: 'tagRevisionInput', inputType: 'TagRevisionInput', resultKey: 'tagMutationResult', resultType: 'TagMutationResult', paramDescription: 'Tag id and expected revision.', line: 168 },
  { name: 'restoreTag', description: 'Restore an archived tag.', inputKey: 'tagRevisionInput', inputType: 'TagRevisionInput', resultKey: 'tagMutationResult', resultType: 'TagMutationResult', paramDescription: 'Tag id and expected revision.', line: 176 },
  { name: 'createBackup', description: 'Create a verified online SQLite backup and prune excess old plugin backups.', inputKey: 'createBackupInput', inputType: 'CreateBackupInput', resultKey: 'createBackupResult', resultType: 'CreateBackupResult', paramDescription: 'Optional backup reason.', line: 205 },
  { name: 'exportMappingReport', description: 'Export a portable JSON or CSV mapping report for recovery and audit.', inputKey: 'exportMappingReportInput', inputType: 'ExportMappingReportInput', resultKey: 'exportMappingReportResult', resultType: 'ExportMappingReportResult', paramDescription: 'Report format (json or csv).', line: 213 },
  { name: 'fetchIngestionMetadata', description: 'Fetch candidate metadata and tags from FC2CMADB/FC2PPVDB for a staged manifest.', inputKey: 'fetchIngestionMetadataInput', inputType: 'FetchIngestionMetadataInput', resultKey: 'fetchedMetadataCandidate', resultType: 'FetchedMetadataCandidate', paramDescription: 'Manifest id.', line: 250 },
  { name: 'reviewIngestion', description: 'Record human review approval/rejection and confirmed tags for a manifest.', inputKey: 'reviewIngestionInput', inputType: 'ReviewIngestionInput', resultKey: 'reviewIngestionResult', resultType: 'ReviewIngestionResult', paramDescription: 'Review decision, metadata and tags.', line: 258 },
  { name: 'commitIngestion', description: 'Execute a reviewed ingestion manifest (move + verify + index + conservative cleanup).', inputKey: 'commitIngestionInput', inputType: 'CommitIngestionInput', resultKey: 'commitIngestionResult', resultType: 'CommitIngestionResult', paramDescription: 'Manifest id.', line: 266 },
];

function mutationMethodEntry(m: MutationMethodSpec): string {
  const typeSymbol = `'@deepseek-ai/dsh-experimental-media-library#mediaLibrary/${m.name}:input'`;
  const codec = (indent: string): string => `{
${indent}  mode: 'strict',
${indent}  typeSymbol: ${typeSymbol},
${indent}  create: _mediaLibrary_${m.inputKey}$schema,
${indent}  jsonSchema: { type: 'object' },
${indent}}`;
  return `    'mediaLibrary/${m.name}': {
      service: 'mediaLibrary',
      description: ${JSON.stringify(m.description)},
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'input',
          description: ${JSON.stringify(m.paramDescription)},
          source: 'json',
          codec: ${codec('          ')},
          strictCodec: ${codec('          ')},
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#${m.resultType}',
        create: _mediaLibrary_${m.resultKey}$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: ${m.line}, column: 3 },
    },
`;
}
const MUTATION_METHOD_ENTRIES = MUTATION_METHODS.map(mutationMethodEntry).join('');
const MUTATION_DTS_NAMESPACE = MUTATION_METHODS.map(
  m => `    ${m.name}: (input: ${m.inputType}) => Promise<RemoteResult<${m.resultType}>>`,
).join('\n');
const MUTATION_DTS_MAP = MUTATION_METHODS.map(
  m => `    'mediaLibrary/${m.name}': (input: ${m.inputType}) => Promise<RemoteResult<${m.resultType}>>`,
).join('\n');
const MUTATION_DTS_INFO = MUTATION_METHODS.map(
  m => `  readonly 'mediaLibrary/${m.name}': TypertRemoteMethod<{ readonly input: ${m.inputType} }, ${m.resultType}>`,
).join('\n');
const MUTATION_DTS_IMPORTS = [...new Set(MUTATION_METHODS.flatMap(m => [m.inputType, m.resultType]))].sort();

const SHARED_SCHEMAS = `import { z } from 'zod'

import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

let _mediaLibrary_mediaId$schema$value
const _mediaLibrary_mediaId$schema = () => (_mediaLibrary_mediaId$schema$value ??= z.string())

let _mediaLibrary_actionResult$schema$value
const _mediaLibrary_actionResult$schema = () => (_mediaLibrary_actionResult$schema$value ??= z.union([
  z.object({
    ok: z.literal(true).readonly(),
    mediaId: z.string().readonly(),
    action: z.union([z.literal('open'), z.literal('reveal')]).readonly(),
    resolvedUncPath: z.string().readonly(),
    elapsedMs: z.number().readonly(),
  }),
  z.object({
    ok: z.literal(false).readonly(),
    mediaId: z.string().readonly(),
    action: z.union([z.literal('open'), z.literal('reveal')]).readonly(),
    code: z.union([
      z.literal('UNKNOWN_MEDIA_ID'),
      z.literal('UNMAPPED_ROOT'),
      z.literal('DISABLED_ROOT'),
      z.literal('INVALID_UNC_ROOT'),
      z.literal('INVALID_RELATIVE_PATH'),
      z.literal('PATH_TRAVERSAL_REJECTED'),
      z.literal('FILE_NOT_FOUND'),
      z.literal('NAS_OFFLINE_OR_TIMEOUT'),
      z.literal('PERMISSION_DENIED'),
      z.literal('OPENER_FAILED'),
    ]).readonly(),
    message: z.string().readonly(),
    resolvedUncPath: z.string().readonly().optional(),
    elapsedMs: z.number().readonly(),
  }),
]))

let _mediaLibrary_spikeStatus$schema$value
const _mediaLibrary_spikeStatus$schema = () => (_mediaLibrary_spikeStatus$schema$value ??= z.object({
  platform: z.string().readonly(),
  nodeVersion: z.string().readonly(),
  nodeSqliteAvailable: z.boolean().readonly(),
  localDataDir: z.string().readonly(),
  localDatabasePath: z.string().readonly(),
  spikeOverridePath: z.string().readonly(),
  activeUncRoot: z.string().readonly(),
  roots: z.array(z.object({
    rootId: z.string().readonly(),
    label: z.string().readonly(),
    canonicalUncRoot: z.string().readonly(),
    enabled: z.boolean().readonly(),
  })).readonly(),
  items: z.array(z.object({
    mediaId: z.string().readonly(),
    rootId: z.string().readonly(),
    relativePath: z.string().readonly(),
    label: z.string().readonly(),
    scenario: z.union([
      z.literal('basic'),
      z.literal('spaces'),
      z.literal('cjk'),
      z.literal('comma'),
      z.literal('long_path'),
      z.literal('missing_file'),
    ]).readonly(),
  })).readonly(),
}))

let _mediaLibrary_libraryOverview$schema$value
const _mediaLibrary_libraryOverview$schema = () => (_mediaLibrary_libraryOverview$schema$value ??= z.object({
  databasePath: z.string().readonly(),
  databaseExists: z.boolean().readonly(),
  schemaVersion: z.number().readonly(),
  activeUncRoot: z.string().readonly(),
  defaultTagStudioSourcePath: z.string().readonly(),
  counts: z.object({
    mediaFiles: z.number().readonly(),
    tags: z.number().readonly(),
    tagAliases: z.number().readonly(),
    mediaTags: z.number().readonly(),
    importRuns: z.number().readonly(),
  }).readonly(),
  lastImport: z.object({
    finishedAt: z.string().readonly(),
    status: z.string().readonly(),
    sourceFingerprint: z.string().readonly(),
    importedEntries: z.number().readonly(),
    skippedSidecarEntries: z.number().readonly(),
    importedTags: z.number().readonly(),
  }).nullable().readonly(),
}))

let _mediaLibrary_listTagsInput$schema$value
const _mediaLibrary_listTagsInput$schema = () => (_mediaLibrary_listTagsInput$schema$value ??= z.object({
  query: z.string().optional().readonly(),
  limit: z.number().optional().readonly(),
  includeArchived: z.boolean().optional().readonly(),
}).optional())

let _mediaLibrary_listTagsResult$schema$value
const _mediaLibrary_listTagsResult$schema = () => (_mediaLibrary_listTagsResult$schema$value ??= z.object({
  tags: z.array(z.object({
    id: z.number().readonly(),
    name: z.string().readonly(),
    normalizedName: z.string().readonly(),
    shorthand: z.string().nullable().readonly(),
    aliases: z.array(z.string()).readonly(),
    mediaCount: z.number().readonly(),
    revision: z.number().readonly(),
    archived: z.boolean().readonly(),
    mergedIntoId: z.number().nullable().readonly(),
  })).readonly(),
  ambiguousAliases: z.array(z.object({
    normalizedAlias: z.string().readonly(),
    matchingTags: z.array(z.object({
      id: z.number().readonly(),
      name: z.string().readonly(),
    })).readonly(),
  })).readonly(),
}))

let _mediaLibrary_searchMediaInput$schema$value
const _mediaLibrary_searchMediaInput$schema = () => (_mediaLibrary_searchMediaInput$schema$value ??= z.object({
  text: z.string().optional().readonly(),
  catalogNumber: z.string().optional().readonly(),
  catalogMatchMode: z.union([z.literal('exact'), z.literal('prefix')]).optional().readonly(),
  tagIds: z.array(z.number()).optional().readonly(),
  tagNamesOrAliases: z.array(z.string()).optional().readonly(),
  dateFrom: z.string().optional().readonly(),
  dateTo: z.string().optional().readonly(),
  cursor: z.string().optional().readonly(),
  limit: z.number().optional().readonly(),
}).optional())

const _mediaLibrary_statusEnum = () => z.union([
  z.literal('indexed'),
  z.literal('missing'),
  z.literal('offline'),
  z.literal('unmapped'),
  z.literal('permission_denied'),
])

const _mediaLibrary_searchItemObj = () => z.object({
  mediaId: z.string().readonly(),
  id: z.number().readonly(),
  rootId: z.string().readonly(),
  relativePath: z.string().readonly(),
  filename: z.string().readonly(),
  extension: z.string().readonly(),
  title: z.string().nullable().readonly(),
  catalogNumber: z.string().nullable().readonly(),
  mediaDate: z.string().nullable().readonly(),
  addedAt: z.string().nullable().readonly(),
  status: _mediaLibrary_statusEnum().readonly(),
  revision: z.number().readonly(),
  tags: z.array(z.object({
    id: z.number().readonly(),
    name: z.string().readonly(),
    shorthand: z.string().nullable().readonly(),
  })).readonly(),
})

let _mediaLibrary_searchMediaResult$schema$value
const _mediaLibrary_searchMediaResult$schema = () => (_mediaLibrary_searchMediaResult$schema$value ??= z.object({
  items: z.array(_mediaLibrary_searchItemObj()).readonly(),
  nextCursor: z.string().nullable().readonly(),
  totalMatching: z.number().readonly(),
  elapsedMs: z.number().readonly(),
  resolvedTagIds: z.array(z.number()).readonly(),
  unresolvedTagQueries: z.array(z.string()).readonly(),
  ambiguousAliases: z.array(z.object({
    normalizedAlias: z.string().readonly(),
    matchingTags: z.array(z.object({
      id: z.number().readonly(),
      name: z.string().readonly(),
    })).readonly(),
  })).readonly(),
}))

let _mediaLibrary_getMediaInput$schema$value
const _mediaLibrary_getMediaInput$schema = () => (_mediaLibrary_getMediaInput$schema$value ??= z.object({
  mediaId: z.string().readonly(),
}))

let _mediaLibrary_getMediaResult$schema$value
const _mediaLibrary_getMediaResult$schema = () => (_mediaLibrary_getMediaResult$schema$value ??= z.object({
  mediaId: z.string().readonly(),
  id: z.number().readonly(),
  rootId: z.string().readonly(),
  relativePath: z.string().readonly(),
  filename: z.string().readonly(),
  extension: z.string().readonly(),
  title: z.string().nullable().readonly(),
  catalogNumber: z.string().nullable().readonly(),
  catalogSource: z.string().nullable().readonly(),
  mediaDate: z.string().nullable().readonly(),
  dateSource: z.string().nullable().readonly(),
  addedAt: z.string().nullable().readonly(),
  status: _mediaLibrary_statusEnum().readonly(),
  revision: z.number().readonly(),
  tags: z.array(z.object({
    id: z.number().readonly(),
    name: z.string().readonly(),
    shorthand: z.string().nullable().readonly(),
  })).readonly(),
  textFields: z.array(z.object({
    name: z.string().readonly(),
    value: z.string().readonly(),
    isMultiline: z.boolean().readonly(),
  })).readonly(),
}).nullable())

let _mediaLibrary_importInput$schema$value
const _mediaLibrary_importInput$schema = () => (_mediaLibrary_importInput$schema$value ??= z.object({
  sourceDbPath: z.string().optional().readonly(),
  uncRoot: z.string().optional().readonly(),
  force: z.boolean().optional().readonly(),
}).optional())

let _mediaLibrary_importResult$schema$value
const _mediaLibrary_importResult$schema = () => (_mediaLibrary_importResult$schema$value ??= z.object({
  ok: z.boolean().readonly(),
  status: z.union([
    z.literal('succeeded'),
    z.literal('already_imported'),
    z.literal('failed'),
  ]).readonly(),
  message: z.string().readonly(),
  importedEntries: z.number().readonly(),
  skippedSidecarEntries: z.number().readonly(),
  importedTags: z.number().readonly(),
  importedMediaTags: z.number().readonly(),
  sourceSha256: z.string().readonly(),
}))

${MUTATION_SCHEMAS}
`;

const REMOTE_INFO_BODY = `{
  package: '@deepseek-ai/dsh-experimental-media-library',
  methods: {
    'mediaLibrary/getLibraryOverview': {
      service: 'mediaLibrary',
      description: 'Read local SQLite database overview, counts, and last import summary.',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#LibraryOverview',
        create: _mediaLibrary_libraryOverview$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 54, column: 3 },
    },
    'mediaLibrary/getOpsStatus': {
      service: 'mediaLibrary',
      description: 'Read backup retention, degraded-mode status, and managed backup inventory.',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#OpsStatus',
        create: _mediaLibrary_opsStatus$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 197, column: 3 },
    },
    'mediaLibrary/scanStagingFiles': {
      service: 'mediaLibrary',
      description: 'Scan the configured staging temp directory and plan recoverable manifests.',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#ScanStagingResult',
        create: _mediaLibrary_scanStagingResult$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 234, column: 3 },
    },
    'mediaLibrary/listIngestionManifests': {
      service: 'mediaLibrary',
      description: 'List staged/reviewed/moving/indexed/failed ingestion manifests.',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#IngestionManifest[]',
        create: _mediaLibrary_ingestionManifestList$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 242, column: 3 },
    },
    'mediaLibrary/reconcileIngestion': {
      service: 'mediaLibrary',
      description: 'Reconcile interrupted manifests (copied-not-deleted, moved-not-indexed, indexed-but-missing).',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#ReconcileIngestionResult',
        create: _mediaLibrary_reconcileIngestionResult$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 274, column: 3 },
    },
    'mediaLibrary/getMedia': {
      service: 'mediaLibrary',
      description: 'Get full details for a single media item by its mediaId.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'input',
          description: 'Media lookup input.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/getMedia:input',
            create: _mediaLibrary_getMediaInput$schema,
            jsonSchema: { type: 'object' },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/getMedia:input',
            create: _mediaLibrary_getMediaInput$schema,
            jsonSchema: { type: 'object' },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#MediaDetailItem',
        create: _mediaLibrary_getMediaResult$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 78, column: 3 },
    },
    'mediaLibrary/importTagStudioCopy': {
      service: 'mediaLibrary',
      description: 'Import a read-only TagStudio ts_library.sqlite copy into the local SQLite database.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'input',
          description: 'Optional import parameters.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/importTagStudioCopy:input',
            create: _mediaLibrary_importInput$schema,
            jsonSchema: { type: 'object' },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/importTagStudioCopy:input',
            create: _mediaLibrary_importInput$schema,
            jsonSchema: { type: 'object' },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#ImportTagStudioResult',
        create: _mediaLibrary_importResult$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 86, column: 3 },
    },
    'mediaLibrary/listTags': {
      service: 'mediaLibrary',
      description: 'List or search tags by name, shorthand, or alias.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'input',
          description: 'Tag filter parameters.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/listTags:input',
            create: _mediaLibrary_listTagsInput$schema,
            jsonSchema: { type: 'object' },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/listTags:input',
            create: _mediaLibrary_listTagsInput$schema,
            jsonSchema: { type: 'object' },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#ListTagsResult',
        create: _mediaLibrary_listTagsResult$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 62, column: 3 },
    },
    'mediaLibrary/openMedia': {
      service: 'mediaLibrary',
      description: 'Open a media item by its allowlisted mediaId in the default Windows media player.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'mediaId',
          description: 'Registered media item identifier.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/openMedia:mediaId',
            create: _mediaLibrary_mediaId$schema,
            jsonSchema: { type: 'string' },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/openMedia:mediaId',
            create: _mediaLibrary_mediaId$schema,
            jsonSchema: { type: 'string' },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#MediaActionResult',
        create: _mediaLibrary_actionResult$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 95, column: 3 },
    },
    'mediaLibrary/revealMedia': {
      service: 'mediaLibrary',
      description: 'Reveal and highlight a media item by its allowlisted mediaId in Windows Explorer.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'mediaId',
          description: 'Registered media item identifier.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/revealMedia:mediaId',
            create: _mediaLibrary_mediaId$schema,
            jsonSchema: { type: 'string' },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/revealMedia:mediaId',
            create: _mediaLibrary_mediaId$schema,
            jsonSchema: { type: 'string' },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#MediaActionResult',
        create: _mediaLibrary_actionResult$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 104, column: 3 },
    },
    'mediaLibrary/searchMedia': {
      service: 'mediaLibrary',
      description: 'Search imported media by text, catalog number, date range, and multi-tag AND filters with stable keyset pagination.',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'input',
          description: 'Search filter and cursor parameters.',
          source: 'json',
          codec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/searchMedia:input',
            create: _mediaLibrary_searchMediaInput$schema,
            jsonSchema: { type: 'object' },
          },
          strictCodec: {
            mode: 'strict',
            typeSymbol: '@deepseek-ai/dsh-experimental-media-library#mediaLibrary/searchMedia:input',
            create: _mediaLibrary_searchMediaInput$schema,
            jsonSchema: { type: 'object' },
          },
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#SearchMediaResult',
        create: _mediaLibrary_searchMediaResult$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 70, column: 3 },
    },
    'mediaLibrary/spikeStatus': {
      service: 'mediaLibrary',
      description: 'Read Host runtime diagnostics, local non-SMB SQLite paths, and M1 test items.',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-experimental-media-library/types#SpikeStatus',
        create: _mediaLibrary_spikeStatus$schema,
      },
      sourceLocation: { file: 'packages/experimental/dsh-media-library/src/remote.ts', line: 46, column: 3 },
    },
${MUTATION_METHOD_ENTRIES}  },
}`;

const HOST_JS = `/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */
${SHARED_SCHEMAS}
const $remote = createTypertRemoteInfo(${REMOTE_INFO_BODY}, z)

export const TYPERT = {
  package: '@deepseek-ai/dsh-experimental-media-library',
  face: 'host',
  schemas: [],
  get invocations() { return $remote.descriptors },
  model: {
    services: [],
    events: [],
    objects: [],
  },
}
`;

const HOST_DTS = `/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */

export declare const TYPERT: unknown
`;

const REMOTE_CLIENT_JS = `/* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */
${SHARED_SCHEMAS}
export const TYPERT_REMOTE = createTypertRemoteInfo(${REMOTE_INFO_BODY}, z)

export default TYPERT_REMOTE
`;

const REMOTE_CLIENT_DTS = `/* Generated by @deepseek-ai/dsh-typert-generator from the Host FaceModel — do not edit. */
import type {
  RemoteResult,
  TypertRemoteInfo,
  TypertRemoteMethod,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  GetMediaInput,
  ImportTagStudioInput,
  ImportTagStudioResult,
  LibraryOverview,
  ListTagsInput,
  ListTagsResult,
  MediaActionResult,
  MediaDetailItem,
  SearchMediaInput,
  SearchMediaResult,
  SpikeStatus,
  OpsStatus,
  ScanStagingResult,
  IngestionManifest,
  ReconcileIngestionResult,
${MUTATION_DTS_IMPORTS.map(n => `  ${n},`).join('\n')}
} from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$mediaLibrary {
    getLibraryOverview: () => Promise<RemoteResult<LibraryOverview>>
    getMedia: (input: GetMediaInput) => Promise<RemoteResult<MediaDetailItem | null>>
    getOpsStatus: () => Promise<RemoteResult<OpsStatus>>
    scanStagingFiles: () => Promise<RemoteResult<ScanStagingResult>>
    listIngestionManifests: () => Promise<RemoteResult<IngestionManifest[]>>
    reconcileIngestion: () => Promise<RemoteResult<ReconcileIngestionResult>>
    importTagStudioCopy: (input?: ImportTagStudioInput) => Promise<RemoteResult<ImportTagStudioResult>>
    listTags: (input?: ListTagsInput) => Promise<RemoteResult<ListTagsResult>>
    openMedia: (mediaId: string) => Promise<RemoteResult<MediaActionResult>>
    revealMedia: (mediaId: string) => Promise<RemoteResult<MediaActionResult>>
    searchMedia: (input?: SearchMediaInput) => Promise<RemoteResult<SearchMediaResult>>
    spikeStatus: () => Promise<RemoteResult<SpikeStatus>>
${MUTATION_DTS_NAMESPACE}
  }
  interface TypertRemoteMap {
    'mediaLibrary/getLibraryOverview': () => Promise<RemoteResult<LibraryOverview>>
    'mediaLibrary/getMedia': (input: GetMediaInput) => Promise<RemoteResult<MediaDetailItem | null>>
    'mediaLibrary/getOpsStatus': () => Promise<RemoteResult<OpsStatus>>
    'mediaLibrary/scanStagingFiles': () => Promise<RemoteResult<ScanStagingResult>>
    'mediaLibrary/listIngestionManifests': () => Promise<RemoteResult<IngestionManifest[]>>
    'mediaLibrary/reconcileIngestion': () => Promise<RemoteResult<ReconcileIngestionResult>>
    'mediaLibrary/importTagStudioCopy': (input?: ImportTagStudioInput) => Promise<RemoteResult<ImportTagStudioResult>>
    'mediaLibrary/listTags': (input?: ListTagsInput) => Promise<RemoteResult<ListTagsResult>>
    'mediaLibrary/openMedia': (mediaId: string) => Promise<RemoteResult<MediaActionResult>>
    'mediaLibrary/revealMedia': (mediaId: string) => Promise<RemoteResult<MediaActionResult>>
    'mediaLibrary/searchMedia': (input?: SearchMediaInput) => Promise<RemoteResult<SearchMediaResult>>
    'mediaLibrary/spikeStatus': () => Promise<RemoteResult<SpikeStatus>>
${MUTATION_DTS_MAP}
  }
  interface TypertRemoteNamespaceMap {
    mediaLibrary: TypertRemoteNamespace$mediaLibrary
  }
}

export declare const TYPERT_REMOTE: TypertRemoteInfo<{
  readonly 'mediaLibrary/getLibraryOverview': TypertRemoteMethod<{}, LibraryOverview>
  readonly 'mediaLibrary/getMedia': TypertRemoteMethod<{ readonly input: GetMediaInput }, MediaDetailItem | null>
  readonly 'mediaLibrary/getOpsStatus': TypertRemoteMethod<{}, OpsStatus>
  readonly 'mediaLibrary/scanStagingFiles': TypertRemoteMethod<{}, ScanStagingResult>
  readonly 'mediaLibrary/listIngestionManifests': TypertRemoteMethod<{}, IngestionManifest[]>
  readonly 'mediaLibrary/reconcileIngestion': TypertRemoteMethod<{}, ReconcileIngestionResult>
  readonly 'mediaLibrary/importTagStudioCopy': TypertRemoteMethod<{ readonly input?: ImportTagStudioInput }, ImportTagStudioResult>
  readonly 'mediaLibrary/listTags': TypertRemoteMethod<{ readonly input?: ListTagsInput }, ListTagsResult>
  readonly 'mediaLibrary/openMedia': TypertRemoteMethod<{ readonly mediaId: string }, MediaActionResult>
  readonly 'mediaLibrary/revealMedia': TypertRemoteMethod<{ readonly mediaId: string }, MediaActionResult>
  readonly 'mediaLibrary/searchMedia': TypertRemoteMethod<{ readonly input?: SearchMediaInput }, SearchMediaResult>
  readonly 'mediaLibrary/spikeStatus': TypertRemoteMethod<{}, SpikeStatus>
${MUTATION_DTS_INFO}
}>
export default TYPERT_REMOTE
`;

fs.mkdirSync(LIB_DIR, { recursive: true });
fs.writeFileSync(path.join(LIB_DIR, 'typert.host.src.js'), HOST_JS, 'utf8');
fs.writeFileSync(path.join(LIB_DIR, 'typert.host.d.ts'), HOST_DTS, 'utf8');
fs.writeFileSync(path.join(LIB_DIR, 'typert.remote-client.js'), REMOTE_CLIENT_JS, 'utf8');
fs.writeFileSync(path.join(LIB_DIR, 'typert.remote-client.d.ts'), REMOTE_CLIENT_DTS, 'utf8');
