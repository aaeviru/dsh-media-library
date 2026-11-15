import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const LIB_DIR = path.join(REPO_ROOT, 'lib');

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
  },
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
} from '../src/types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$mediaLibrary {
    getLibraryOverview: () => Promise<RemoteResult<LibraryOverview>>
    getMedia: (input: GetMediaInput) => Promise<RemoteResult<MediaDetailItem | null>>
    importTagStudioCopy: (input?: ImportTagStudioInput) => Promise<RemoteResult<ImportTagStudioResult>>
    listTags: (input?: ListTagsInput) => Promise<RemoteResult<ListTagsResult>>
    openMedia: (mediaId: string) => Promise<RemoteResult<MediaActionResult>>
    revealMedia: (mediaId: string) => Promise<RemoteResult<MediaActionResult>>
    searchMedia: (input?: SearchMediaInput) => Promise<RemoteResult<SearchMediaResult>>
    spikeStatus: () => Promise<RemoteResult<SpikeStatus>>
  }
  interface TypertRemoteMap {
    'mediaLibrary/getLibraryOverview': () => Promise<RemoteResult<LibraryOverview>>
    'mediaLibrary/getMedia': (input: GetMediaInput) => Promise<RemoteResult<MediaDetailItem | null>>
    'mediaLibrary/importTagStudioCopy': (input?: ImportTagStudioInput) => Promise<RemoteResult<ImportTagStudioResult>>
    'mediaLibrary/listTags': (input?: ListTagsInput) => Promise<RemoteResult<ListTagsResult>>
    'mediaLibrary/openMedia': (mediaId: string) => Promise<RemoteResult<MediaActionResult>>
    'mediaLibrary/revealMedia': (mediaId: string) => Promise<RemoteResult<MediaActionResult>>
    'mediaLibrary/searchMedia': (input?: SearchMediaInput) => Promise<RemoteResult<SearchMediaResult>>
    'mediaLibrary/spikeStatus': () => Promise<RemoteResult<SpikeStatus>>
  }
  interface TypertRemoteNamespaceMap {
    mediaLibrary: TypertRemoteNamespace$mediaLibrary
  }
}

export declare const TYPERT_REMOTE: TypertRemoteInfo<{
  readonly 'mediaLibrary/getLibraryOverview': TypertRemoteMethod<{}, LibraryOverview>
  readonly 'mediaLibrary/getMedia': TypertRemoteMethod<{ readonly input: GetMediaInput }, MediaDetailItem | null>
  readonly 'mediaLibrary/importTagStudioCopy': TypertRemoteMethod<{ readonly input?: ImportTagStudioInput }, ImportTagStudioResult>
  readonly 'mediaLibrary/listTags': TypertRemoteMethod<{ readonly input?: ListTagsInput }, ListTagsResult>
  readonly 'mediaLibrary/openMedia': TypertRemoteMethod<{ readonly mediaId: string }, MediaActionResult>
  readonly 'mediaLibrary/revealMedia': TypertRemoteMethod<{ readonly mediaId: string }, MediaActionResult>
  readonly 'mediaLibrary/searchMedia': TypertRemoteMethod<{ readonly input?: SearchMediaInput }, SearchMediaResult>
  readonly 'mediaLibrary/spikeStatus': TypertRemoteMethod<{}, SpikeStatus>
}>
export default TYPERT_REMOTE
`;

fs.mkdirSync(LIB_DIR, { recursive: true });
fs.writeFileSync(path.join(LIB_DIR, 'typert.host.src.js'), HOST_JS, 'utf8');
fs.writeFileSync(path.join(LIB_DIR, 'typert.host.d.ts'), HOST_DTS, 'utf8');
fs.writeFileSync(path.join(LIB_DIR, 'typert.remote-client.js'), REMOTE_CLIENT_JS, 'utf8');
fs.writeFileSync(path.join(LIB_DIR, 'typert.remote-client.d.ts'), REMOTE_CLIENT_DTS, 'utf8');
