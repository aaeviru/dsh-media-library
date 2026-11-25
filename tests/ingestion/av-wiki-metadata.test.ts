import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Config } from '../../src/config.ts';
import { migrateDatabase } from '../../src/db/schema.ts';
import {
  defaultIngestionFileOps,
  ensureManifestForStagingFile,
  fetchMetadataForManifest,
  getIngestionManifestById,
  MetadataFetcher,
  parseAvWikiHtml,
  parseStandardProductCode,
  resolveMetadataLookupRoute,
} from '../../src/ingestion/index.ts';
import {
  extractCatalogNumber,
  IGNORED_CATALOG_PREFIXES,
  UNCENSORED_STUDIO_PREFIXES,
  UNCENSORED_STUDIO_REGEX,
} from '../../src/inventory/tagstudio-inventory.ts';
import { listPerformerReviewQueue } from '../../src/performers/index.ts';
import { MediaLibrarySpikeService } from '../../src/spike-service.ts';
import type { MediaRootConfig } from '../../src/types.ts';

function sampleAvWikiHtml(overrides?: {
  title?: string;
  ogTitle?: string;
  body?: string;
}): string {
  const titleTag =
    overrides?.title !== undefined
      ? overrides.title
      : '<title>ABP-576：風俗タワー 性感フルコース3時間SPECIAL「豪華版」!&amp;特典に出てるAV女優名まとめ | AV-WIKI</title>';
  const ogTag =
    overrides?.ogTitle !== undefined
      ? overrides.ogTitle
      : '<meta property="og:title" content="ABP-576：OG Fallback Titleに出てるAV女優名まとめ">';
  const body =
    overrides?.body !== undefined
      ? overrides.body
      : `
        <article>
          <dl class="dltable">
            <dt>AV女優名</dt>
            <dd>
              <a href="https://av-wiki.net/av-actress/ootori-kaname/">凰かなめ</a>
              <a href="https://av-wiki.net/av-actress/ootori-kaname-dup/">凰かなめ</a>
              <a href="https://av-wiki.net/av-actress/mitani-akari/">美谷朱里</a>
            </dd>
            <dt>メーカー</dt>
            <dd><a href="https://av-wiki.net/maker/prestige/">プレステージ</a></dd>
            <dt>メーカー品番</dt>
            <dd>ABP-576</dd>
            <dt>配信開始日</dt>
            <dd>2017-03-10</dd>
          </dl>
          <div class="post-tags">
            <a rel="tag" href="https://av-wiki.net/tag/noisy-1/">ノイズタグ1</a>
            <a rel="tag" href="https://av-wiki.net/tag/noisy-2/">単体作品</a>
          </div>
        </article>
      `;
  return `<!doctype html><html><head>${titleTag}${ogTag}</head><body>${body}</body></html>`;
}

describe('AV-WIKI Remote Metadata Integration (Issue #67 B1..B5)', () => {
  it('B1: exports shared blocklists, skips leading technical tokens via matchAll, and guards uncensored studio codes', () => {
    for (const token of [
      'VIDEO', 'AUDIO', 'SAMPLE', 'H264', 'H265', 'X264', 'X265', 'HEVC', 'AVC',
      '1080P', '720P', '480P', '2160P', 'FHD', 'UHD', 'MP3', 'MP4', 'MOV', 'FLV',
      'WEBM', 'M4V', 'MPG', 'MPEG', 'FC2', 'PPV', 'UTF', 'SHA',
    ]) {
      assert.equal(IGNORED_CATALOG_PREFIXES.has(token), true, `Expected ${token} in IGNORED_CATALOG_PREFIXES`);
    }
    for (const studio of ['1PON', '1PONDO', '10MU', '10MUSUME', 'CARIB', 'CARIBPR', 'PACOPACOMAMA']) {
      assert.equal(UNCENSORED_STUDIO_PREFIXES.has(studio), true, `Expected ${studio} in UNCENSORED_STUDIO_PREFIXES`);
    }
    assert.equal(UNCENSORED_STUDIO_REGEX.test('061315_01-10mu-1080p.mp4'), true);

    // Leading technical tokens are skipped instead of aborting extraction.
    assert.equal(extractCatalogNumber('VIDEO-001_ABP-576.mp4'), 'ABP-576');
    assert.equal(extractCatalogNumber('SAMPLE-01_MP4-02_SSIS-123.mkv'), 'SSIS-123');
    assert.equal(extractCatalogNumber('720P-01_300MAAN-341.mp4'), '300MAAN-341');

    // Normalized uncensored studio codes stay uncensored and never match as standard maker codes.
    assert.equal(extractCatalogNumber('061315_01-10mu-1080p.mp4'), '10MU-061315_01');
    assert.equal(extractCatalogNumber('10MU-061315_01'), '10MU-061315_01');
    assert.equal(extractCatalogNumber('10MU-061315'), null);
    assert.equal(extractCatalogNumber('1PON-052615'), null);
    assert.equal(extractCatalogNumber('VIDEO-001.mp4'), null);

    // Standard product code parsing: zero-padding, optional part suffix, and strict rejections.
    assert.deepEqual(parseStandardProductCode('ABP-76.mp4'), {
      prefix: 'ABP',
      number: '076',
      partSuffix: '',
      baseCode: 'ABP-076',
      code: 'ABP-076',
      baseSlug: 'abp-076',
      slug: 'abp-076',
    });
    assert.deepEqual(parseStandardProductCode('VIDEO-001_ABP-576-1.mp4'), {
      prefix: 'ABP',
      number: '576',
      partSuffix: '1',
      baseCode: 'ABP-576',
      code: 'ABP-576-1',
      baseSlug: 'abp-576',
      slug: 'abp-576-1',
    });
    assert.equal(parseStandardProductCode('ABP-576-C.mp4')?.slug, 'abp-576');
    assert.equal(parseStandardProductCode('300MAAN-341.mp4')?.slug, '300maan-341');
    assert.equal(parseStandardProductCode('T28-513.mp4')?.slug, 't28-513');
    assert.equal(parseStandardProductCode('T-28634.mp4')?.slug, 't-28634');
    assert.equal(parseStandardProductCode('MBR-AA024.mp4')?.slug, 'mbr-aa024');

    // Reject FC2, uncensored studio codes (raw & normalized), and technical prefixes.
    assert.equal(parseStandardProductCode('FC2-PPV-4545625.mp4'), null);
    assert.equal(parseStandardProductCode('FC2-1476760-1hana.mp4'), null);
    assert.equal(parseStandardProductCode('061315_01-10mu-1080p.mp4'), null);
    assert.equal(parseStandardProductCode('052615_086-1pon.mp4'), null);
    assert.equal(parseStandardProductCode('10MU-061315_01'), null);
    assert.equal(parseStandardProductCode('CARIBPR-052215_221'), null);
    assert.equal(parseStandardProductCode('VIDEO-001.mp4'), null);
    assert.equal(parseStandardProductCode('HEVC-1080.mp4'), null);

    // Deterministic routing: FC2 -> fc2, standard -> avwiki, unsupported -> null.
    const fc2Route = resolveMetadataLookupRoute('FC2-PPV-4545625-1.mp4');
    assert.equal(fc2Route?.kind, 'fc2');
    assert.equal(fc2Route?.kind === 'fc2' ? fc2Route.parsed.videoId : '', '4545625');

    const avWikiRoute = resolveMetadataLookupRoute('ABP-576-1.mp4');
    assert.equal(avWikiRoute?.kind, 'avwiki');
    assert.equal(avWikiRoute?.kind === 'avwiki' ? avWikiRoute.parsed.slug : '', 'abp-576-1');

    assert.equal(resolveMetadataLookupRoute('10MU-061315_01'), null);
    assert.equal(resolveMetadataLookupRoute('061315_01-10mu-1080p.mp4'), null);
    assert.equal(resolveMetadataLookupRoute('random_home_clip.mp4'), null);
  });

  it('B2: parseAvWikiHtml extracts clean title, actresses, maker, date, and ignores noisy generic tags', () => {
    const res = parseAvWikiHtml(sampleAvWikiHtml(), 'ABP-576', 'https://av-wiki.net/abp-576/');
    assert.equal(res.category, 'ok');
    assert.equal(res.metadata?.provider, 'AVWIKI');
    assert.equal(res.metadata?.videoId, 'ABP-576');
    assert.equal(res.metadata?.title, '風俗タワー 性感フルコース3時間SPECIAL「豪華版」!&特典');
    assert.deepEqual(res.metadata?.actresses, ['凰かなめ', '美谷朱里']);
    assert.equal(res.metadata?.writer, 'プレステージ');
    assert.equal(res.metadata?.mediaDate, '2017-03-10');
    assert.deepEqual(res.metadata?.candidateTags, ['凰かなめ', '美谷朱里', 'プレステージ']);

    // Title with CODE: and trailing ` | ...` (without `に出てるAV女優...`)
    const pipeTitleRes = parseAvWikiHtml(
      sampleAvWikiHtml({
        title: '<title>ABP-76: Clean Title (Special) | AV-WIKI</title>',
        ogTitle: '',
      }),
      'ABP-076',
      'https://av-wiki.net/abp-076/',
    );
    assert.equal(pipeTitleRes.category, 'ok');
    assert.equal(pipeTitleRes.metadata?.title, 'Clean Title (Special)');

    // Fallback to og:title when <title> is site-only or empty
    const ogFallbackRes = parseAvWikiHtml(
      sampleAvWikiHtml({
        title: '<title>AV-WIKI</title>',
        ogTitle: '<meta content="ABP-576：Don\'t Stop! OG Titleに出てるAV女優名まとめ" property="og:title">',
      }),
      'ABP-576',
      'https://av-wiki.net/abp-576/',
    );
    assert.equal(ogFallbackRes.category, 'ok');
    assert.equal(ogFallbackRes.metadata?.title, "Don't Stop! OG Title");

    // Plain-text <dd> actress splitting on `,` / `、` / `/` / `・` / whitespace
    const plainDdRes = parseAvWikiHtml(
      sampleAvWikiHtml({
        body: `
          <dl>
            <dt>AV女優名</dt>
            <dd>女優A、女優B, 女優C / 女優D・女優E 女優F 女優A</dd>
            <dt>メーカー</dt>
            <dd>エスワン</dd>
            <dt>発売日</dt>
            <dd>2024年5月9日</dd>
          </dl>
        `,
      }),
      'SSIS-001',
      'https://av-wiki.net/ssis-001/',
    );
    assert.equal(plainDdRes.category, 'ok');
    assert.deepEqual(plainDdRes.metadata?.actresses, ['女優A', '女優B', '女優C', '女優D', '女優E', '女優F']);
    assert.equal(plainDdRes.metadata?.writer, 'エスワン');
    assert.equal(plainDdRes.metadata?.mediaDate, '2024-05-09');
    assert.deepEqual(plainDdRes.metadata?.candidateTags, [
      '女優A',
      '女優B',
      '女優C',
      '女優D',
      '女優E',
      '女優F',
      'エスワン',
    ]);

    // Plain-text fallback for actresses and date (does not accidentally scrape `<title>...に出てるAV女優名まとめ`)
    const plainTextFallbackRes = parseAvWikiHtml(
      sampleAvWikiHtml({
        body: '<p>作品紹介 AV女優名：三上悠亜・橋本ありな メーカー品番：SSIS-001 配信日：2023/08/15 FANZAで配信中</p>',
      }),
      'SSIS-001',
      'https://av-wiki.net/ssis-001/',
    );
    assert.equal(plainTextFallbackRes.category, 'ok');
    assert.deepEqual(plainTextFallbackRes.metadata?.actresses, ['三上悠亜', '橋本ありな']);
    assert.equal(plainTextFallbackRes.metadata?.mediaDate, '2023-08-15');
    assert.equal(plainTextFallbackRes.metadata?.writer, '');
    assert.deepEqual(plainTextFallbackRes.metadata?.candidateTags, ['三上悠亜', '橋本ありな']);

    // Page without actresses in body must NOT match `に出てるAV女優名まとめ` from `<title>`
    const noActressRes = parseAvWikiHtml(
      sampleAvWikiHtml({
        body: '<p>作品説明のみ 公開日：2022/11/03 MGS動画</p>',
      }),
      'ABP-576',
      'https://av-wiki.net/abp-576/',
    );
    assert.equal(noActressRes.category, 'ok');
    assert.deepEqual(noActressRes.metadata?.actresses, []);
    assert.equal(noActressRes.metadata?.mediaDate, '2022-11-03');

    // Missing title -> parse_error
    const missingTitleRes = parseAvWikiHtml(
      '<html><head><title>AV-WIKI</title></head><body><dl><dt>AV女優名</dt><dd>凰かなめ</dd></dl></body></html>',
      'ABP-576',
      'https://av-wiki.net/abp-576/',
    );
    assert.equal(missingTitleRes.metadata, null);
    assert.equal(missingTitleRes.category, 'parse_error');
  });

  it('B3: MetadataFetcher retries transient HTTP, falls back from suffixed slug on 404, and keeps FC2 strictly isolated', async () => {
    // 1) Suffixed slug `abp-576-1` -> 404 -> automatic fallback to `abp-576` with transient 503 retry.
    const requestedUrls: string[] = [];
    let baseAttempts = 0;
    const fetcher = new MetadataFetcher({
      avWikiBaseUrl: 'https://av-wiki.example/',
      retries: 2,
      retryDelayMs: 0,
      requestDelayMs: 0,
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        if (url === 'https://av-wiki.example/abp-576-1/') {
          return { status: 404, ok: false, text: async () => 'Not Found' };
        }
        if (url === 'https://av-wiki.example/abp-576/') {
          baseAttempts += 1;
          if (baseAttempts === 1) {
            return { status: 503, ok: false, text: async () => 'Service Unavailable' };
          }
          return { status: 200, ok: true, text: async () => sampleAvWikiHtml() };
        }
        return { status: 404, ok: false, text: async () => 'Not Found' };
      },
    });

    const parsed = parseStandardProductCode('ABP-576-1.mp4')!;
    const fallbackRes = await fetcher.lookupAvWiki(parsed);
    assert.equal(fallbackRes.category, 'ok');
    assert.equal(fallbackRes.metadata?.provider, 'AVWIKI');
    assert.equal(fallbackRes.sourceUrl, 'https://av-wiki.example/abp-576/');
    assert.deepEqual(requestedUrls, [
      'https://av-wiki.example/abp-576-1/',
      'https://av-wiki.example/abp-576/',
      'https://av-wiki.example/abp-576/',
    ]);

    // 2) Direct hit on suffixed slug does NOT request base slug.
    const directUrls: string[] = [];
    const directFetcher = new MetadataFetcher({
      retries: 1,
      retryDelayMs: 0,
      requestDelayMs: 0,
      fetchImpl: async (url) => {
        directUrls.push(url);
        return { status: 200, ok: true, text: async () => sampleAvWikiHtml() };
      },
    });
    const directRes = await directFetcher.lookupByText('ABP-576-1.mp4');
    assert.equal(directRes.category, 'ok');
    assert.deepEqual(directUrls, ['https://av-wiki.net/abp-576-1/']);

    // 3) Auth block (403) on suffixed slug does NOT fall back to base slug.
    const blockedUrls: string[] = [];
    const blockedFetcher = new MetadataFetcher({
      retries: 2,
      retryDelayMs: 0,
      requestDelayMs: 0,
      fetchImpl: async (url) => {
        blockedUrls.push(url);
        return { status: 403, ok: false, text: async () => 'Forbidden' };
      },
    });
    const blockedRes = await blockedFetcher.lookupByText('ABP-576-1.mp4');
    assert.equal(blockedRes.category, 'auth_or_blocked');
    assert.deepEqual(blockedUrls, ['https://av-wiki.net/abp-576-1/']);

    // 4) FC2-PPV-* NEVER falls back to av-wiki.net even when both FC2 providers return 404.
    const fc2Urls: string[] = [];
    const fc2Fetcher = new MetadataFetcher({
      retries: 1,
      retryDelayMs: 0,
      requestDelayMs: 0,
      fetchImpl: async (url) => {
        fc2Urls.push(url);
        return { status: 404, ok: false, text: async () => 'Not Found' };
      },
    });
    const fc2Miss = await fc2Fetcher.lookupByText('FC2-PPV-4545625.mp4');
    assert.equal(fc2Miss.metadata, null);
    assert.equal(fc2Miss.category, 'not_found');
    assert.deepEqual(fc2Urls, [
      'https://fc2cmadb.com/articles/4545625',
      'https://fc2ppvdb.com/articles/4545625',
    ]);
    assert.equal(fc2Urls.some((u) => u.includes('av-wiki')), false);

    // 5) Uncensored code returns `no_code` with 0 HTTP requests.
    const zeroUrls: string[] = [];
    const zeroFetcher = new MetadataFetcher({
      retries: 1,
      retryDelayMs: 0,
      requestDelayMs: 0,
      fetchImpl: async (url) => {
        zeroUrls.push(url);
        return { status: 200, ok: true, text: async () => '' };
      },
    });
    const uncensoredRes = await zeroFetcher.lookupByText('10MU-061315_01');
    assert.equal(uncensoredRes.category, 'no_code');
    assert.deepEqual(zeroUrls, []);
  });

  it('B4: fetchMetadataForManifest routes standard codes preserving filename suffix, integrates performer queue, and never renames files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-avwiki-b4-'));
    try {
      const stagingDir = path.join(tmpDir, 'staging');
      fs.mkdirSync(stagingDir, { recursive: true });
      const stdFile = path.join(stagingDir, 'ABP-576-1.mp4');
      const uncensoredFile = path.join(stagingDir, '061315_01-10mu-1080p.mp4');
      const fc2File = path.join(stagingDir, 'FC2-PPV-4545625.mp4');
      fs.writeFileSync(stdFile, 'payload-std');
      fs.writeFileSync(uncensoredFile, 'payload-unc');
      fs.writeFileSync(fc2File, 'payload-fc2');

      const dbPath = path.join(tmpDir, 'library.sqlite3');
      const roots: MediaRootConfig[] = [
        { rootId: 'nas-main', label: 'NAS Main', canonicalUncRoot: '\\\\NAS\\MediaTest', enabled: true },
      ];
      const db = new DatabaseSync(dbPath);
      try {
        await migrateDatabase(db, { dbPath, appVersion: '0.7.10' });

        // 1) Standard file with part suffix in filename (`ABP-576-1.mp4`), base code in `catalogNumber` (`ABP-576`).
        const mStd = await ensureManifestForStagingFile(db, {
          tempPath: stdFile,
          stagingDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps: defaultIngestionFileOps,
        });
        assert.equal(mStd.catalogNumber, 'ABP-576');
        assert.equal(mStd.filename, 'ABP-576-1.mp4');

        const seenUrls: string[] = [];
        const fetcher = new MetadataFetcher({
          retries: 1,
          retryDelayMs: 0,
          requestDelayMs: 0,
          fetchImpl: async (url) => {
            seenUrls.push(url);
            if (url === 'https://av-wiki.net/abp-576-1/') {
              return { status: 404, ok: false, text: async () => 'Not Found' };
            }
            if (url === 'https://av-wiki.net/abp-576/') {
              return { status: 200, ok: true, text: async () => sampleAvWikiHtml() };
            }
            if (url === 'https://av-wiki.net/ssis-001/') {
              return {
                status: 200,
                ok: true,
                text: async () =>
                  sampleAvWikiHtml({
                    title: '<title>SSIS-001：Manual Override Titleに出てるAV女優名まとめ | AV-WIKI</title>',
                    body: '<dl><dt>AV女優名</dt><dd><a>三上悠亜</a></dd><dt>メーカー</dt><dd><a>S1</a></dd></dl>',
                  }),
              };
            }
            return { status: 404, ok: false, text: async () => 'Not Found' };
          },
        });

        const fetchedStd = await fetchMetadataForManifest(db, mStd.id, fetcher);
        assert.equal(fetchedStd.ok, true);
        assert.equal(fetchedStd.provider, 'AVWIKI');
        assert.equal(fetchedStd.title, '風俗タワー 性感フルコース3時間SPECIAL「豪華版」!&特典');
        assert.equal(fetchedStd.writer, 'プレステージ');
        assert.deepEqual(fetchedStd.actresses, ['凰かなめ', '美谷朱里']);
        assert.equal(fetchedStd.mediaDate, '2017-03-10');
        assert.equal(fetchedStd.sourceUrl, 'https://av-wiki.net/abp-576/');
        assert.deepEqual(seenUrls, ['https://av-wiki.net/abp-576-1/', 'https://av-wiki.net/abp-576/']);

        // Actresses go to performer review queue (not auto-inserted into normal tags_json); maker stays in tags_json.
        const updatedManifest = getIngestionManifestById(db, mStd.id)!;
        assert.deepEqual(updatedManifest.actresses, ['凰かなめ', '美谷朱里']);
        assert.deepEqual(
          updatedManifest.tags.map((t) => t.name),
          ['プレステージ'],
        );
        const reviewItems = listPerformerReviewQueue(db, { manifestId: mStd.id, status: 'pending' });
        assert.deepEqual(
          reviewItems.map((r) => r.rawName).sort(),
          ['凰かなめ', '美谷朱里'].sort(),
        );

        // Staged file was never renamed or moved.
        assert.equal(fs.existsSync(stdFile), true);

        // 2) Manual catalogNumber override takes precedence over filename when baseCode differs.
        db.prepare('UPDATE ingestion_manifests SET catalog_number = ? WHERE id = ?').run('SSIS-001', mStd.id);
        seenUrls.length = 0;
        const overrideRes = await fetchMetadataForManifest(db, mStd.id, fetcher);
        assert.equal(overrideRes.ok, true);
        assert.equal(overrideRes.title, 'Manual Override Title');
        assert.deepEqual(seenUrls, ['https://av-wiki.net/ssis-001/']);

        // 3) Uncensored studio file produces `no_code` with 0 requests.
        const mUnc = await ensureManifestForStagingFile(db, {
          tempPath: uncensoredFile,
          stagingDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps: defaultIngestionFileOps,
        });
        assert.equal(mUnc.catalogNumber, '10MU-061315_01');
        seenUrls.length = 0;
        const uncRes = await fetchMetadataForManifest(db, mUnc.id, fetcher);
        assert.equal(uncRes.ok, false);
        assert.equal(uncRes.category, 'no_code');
        assert.deepEqual(seenUrls, []);

        // 4) FC2 file routes strictly to FC2 providers, never av-wiki.net.
        const mFc2 = await ensureManifestForStagingFile(db, {
          tempPath: fc2File,
          stagingDir,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps: defaultIngestionFileOps,
        });
        seenUrls.length = 0;
        const fc2Res = await fetchMetadataForManifest(db, mFc2.id, fetcher);
        assert.equal(fc2Res.ok, false);
        assert.equal(fc2Res.category, 'not_found');
        assert.deepEqual(seenUrls, [
          'https://fc2cmadb.com/articles/4545625',
          'https://fc2ppvdb.com/articles/4545625',
        ]);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('B5: avWikiBaseUrl is a volatile Config setting dynamically read by MediaLibrarySpikeService', async () => {
    // Verify Config schema exposes volatile avWikiBaseUrl with default 'https://av-wiki.net'
    const schemaDict = (Config as unknown as { dict?: Record<string, { meta?: { default?: unknown }; type?: string }> }).dict;
    assert.ok(schemaDict?.avWikiBaseUrl, 'Expected avWikiBaseUrl in Config schema');
    const resolvedDefault = Config({} as never);
    assert.equal(typeof resolvedDefault.avWikiBaseUrl.get, 'function');
    assert.equal(resolvedDefault.avWikiBaseUrl.get(), 'https://av-wiki.net');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-avwiki-b5-'));
    const originalFetch = globalThis.fetch;
    try {
      const stagingDir = path.join(tmpDir, 'staging');
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(path.join(stagingDir, 'ABP-576.mp4'), 'payload');

      let activeBaseUrl = 'https://mirror-one.av-wiki.local';
      const seenUrls: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        seenUrls.push(url);
        return {
          status: 200,
          ok: true,
          text: async () => sampleAvWikiHtml(),
        } as unknown as Response;
      }) as typeof fetch;

      const service = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        dbPath: path.join(tmpDir, 'library.sqlite3'),
        configuredStagingDir: () => stagingDir,
        configuredAvWikiBaseUrl: () => activeBaseUrl,
        autoDailyBackup: false,
      });

      const first = await service.fetchIngestionMetadata({ relativePath: 'ABP-576.mp4' });
      assert.equal(first.ok, true);
      assert.equal(first.provider, 'AVWIKI');
      assert.equal(first.sourceUrl, 'https://mirror-one.av-wiki.local/abp-576/');

      // Update volatile setting without recreating service and re-fetch.
      activeBaseUrl = 'https://mirror-two.av-wiki.local/';
      const second = await service.fetchIngestionMetadata({ manifestId: first.manifest!.id });
      assert.equal(second.ok, true);
      assert.equal(second.sourceUrl, 'https://mirror-two.av-wiki.local/abp-576/');
      assert.deepEqual(seenUrls, [
        'https://mirror-one.av-wiki.local/abp-576/',
        'https://mirror-two.av-wiki.local/abp-576/',
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
