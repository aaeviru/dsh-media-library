import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_MIGRATIONS, migrateDatabase } from '../../src/db/schema.ts';
import {
  commitIngestionManifest,
  defaultIngestionFileOps,
  ensureManifestForStagingFile,
  fetchMetadataForManifest,
  MetadataFetcher,
  reviewIngestionManifest,
  type IngestionFileOps,
} from '../../src/ingestion/index.ts';
import {
  archiveTag,
  createTag,
  mergeTags,
  previewMerge,
  removeAutomatedMediaTags,
  renameTag,
} from '../../src/mutations/index.ts';
import {
  deletePerformerAlias,
  evaluateManifestPerformers,
  listPerformerAliases,
  listPerformerReviewQueue,
  normalizePerformerName,
  promotePerformerTagToManual,
  resolvePerformerReview,
  upsertPerformerAlias,
} from '../../src/performers/index.ts';
import { MediaLibrarySpikeService } from '../../src/spike-service.ts';
import type { MediaRootConfig } from '../../src/types.ts';

function setupEnv(tmpDir: string) {
  const tempDir = path.join(tmpDir, 'temp');
  const targetDir = path.join(tmpDir, 'nas-media');
  fs.mkdirSync(tempDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'library.sqlite3');
  const roots: MediaRootConfig[] = [
    { rootId: 'nas-main', label: 'NAS', canonicalUncRoot: '\\\\TestNAS\\Media', enabled: true },
  ];
  const mapUncToLocal = (p: string): string => {
    if (p.startsWith('\\\\TestNAS\\Media')) {
      const rel = p.slice('\\\\TestNAS\\Media'.length).replace(/^\\+/, '').replace(/\\/g, path.sep);
      return path.join(targetDir, rel);
    }
    return p;
  };
  const fileOps: IngestionFileOps = {
    exists: (p) => defaultIngestionFileOps.exists(mapUncToLocal(p)),
    statSize: (p) => defaultIngestionFileOps.statSize(mapUncToLocal(p)),
    sha256: (p) => defaultIngestionFileOps.sha256(mapUncToLocal(p)),
    ensureDir: (p) => defaultIngestionFileOps.ensureDir(mapUncToLocal(p)),
    rename: (src, dst) => defaultIngestionFileOps.rename(mapUncToLocal(src), mapUncToLocal(dst)),
    copyFile: (src, dst) => defaultIngestionFileOps.copyFile(mapUncToLocal(src), mapUncToLocal(dst)),
    removeFile: (p) => defaultIngestionFileOps.removeFile(mapUncToLocal(p)),
  };
  return { tempDir, targetDir, dbPath, roots, fileOps };
}

function makeMockCmadbFetcher(videoId: string, title: string, actresses: string[], tags: string[] = ['巨乳']) {
  const html = `
    <html><body>
      <script data-page="app" type="application/json">
        ${JSON.stringify({
          props: {
            article: {
              video_id: videoId,
              title,
              release_date: '2026-11-18',
              actresses: actresses.map((name) => ({ name })),
              tags: tags.map((name) => ({ name })),
            },
          },
        })}
      </script>
    </body></html>
  `;
  return new MetadataFetcher({
    requestDelayMs: 0,
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => html }),
  });
}

describe('Performer Alias Resolution & Human Review Queue (Issue #8 B1..B7)', () => {
  it('B1: normalizes case folding, Unicode NFKC (fullwidth/halfwidth/NFD), and whitespace deterministically', () => {
    assert.equal(normalizePerformerName('  Ａｌｉｃｅ\u3000K  '), 'alice k');
    assert.equal(normalizePerformerName('ALICE   k'), 'alice k');
    // Halfwidth Katakana -> NFKC fullwidth Katakana
    assert.equal(normalizePerformerName('ｺｺｱ'), normalizePerformerName('ココア'));
    // Decomposed NFD kana (`か` + combining dakuten `\u3099`) -> composed `が`
    assert.equal(normalizePerformerName('か\u3099'), normalizePerformerName('が'));
  });

  it('B1..B4: resolves unique aliases & stage-name changes, queues unknown/ambiguous performers, enforces Policy 1, distinguishes provenance, and protects manual tags', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-perf-b1-'));
    try {
      const { tempDir, dbPath, roots, fileOps } = setupEnv(tmpDir);
      const file1 = path.join(tempDir, 'FC2-PPV-5006891.mp4');
      const file2 = path.join(tempDir, 'FC2-PPV-5003320.mp4');
      const file3 = path.join(tempDir, 'FC2-PPV-5009999.mp4');
      fs.writeFileSync(file1, 'video-1');
      fs.writeFileSync(file2, 'video-2');
      fs.writeFileSync(file3, 'video-3');

      const db = new DatabaseSync(dbPath);
      try {
        await migrateDatabase(db, { dbPath, appVersion: '0.6.0' });
        const nowIso = '2026-11-18T00:00:00.000Z';
        db.prepare(
          `INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
           VALUES ('nas-main', 'NAS', ?, 1, ?)`,
        ).run(roots[0]!.canonicalUncRoot, nowIso);

        // Stage-name change: two aliases pointing to the SAME canonical tag
        const canonicalTag = createTag(db, { name: 'Yua Canonical' });
        assert.equal(canonicalTag.ok, true);
        if (!canonicalTag.ok) return;
        const r1 = upsertPerformerAlias(db, { rawAlias: 'Old Stage Name', tagId: canonicalTag.tagId });
        const r2 = upsertPerformerAlias(db, { rawAlias: 'Ｎｅｗ　Ｓｔａｇｅ　Ｎａｍｅ', tagId: canonicalTag.tagId });
        assert.equal(r1.ok, true);
        assert.equal(r2.ok, true);

        // Same-name performers: two different tags sharing normalized name 'ここあ'
        const cocoaA = createTag(db, { name: 'ここあ (A)' });
        const cocoaB = createTag(db, { name: 'ここあ (B)' });
        assert.equal(cocoaA.ok && cocoaB.ok, true);
        if (!cocoaA.ok || !cocoaB.ok) return;
        upsertPerformerAlias(db, { rawAlias: 'ここあ', tagId: cocoaA.tagId });
        upsertPerformerAlias(db, { rawAlias: 'ここあ', tagId: cocoaB.tagId });

        // 1) Manifest 1 has: known stage-name ('new stage name'), ambiguous ('ここあ'), and unknown ('新人ちゃん')
        const m1 = ensureManifestForStagingFile(db, {
          tempPath: file1,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });
        const fetch1 = await fetchMetadataForManifest(
          db,
          m1.id,
          makeMockCmadbFetcher('5006891', 'Video 1', ['new stage name', 'ここあ', '新人ちゃん'], ['巨乳']),
        );
        assert.equal(fetch1.ok, true);
        // Performers must NOT leak into normal manifest.tags
        assert.deepEqual(
          fetch1.manifest?.tags.map((t) => t.name),
          ['巨乳'],
        );
        assert.deepEqual(fetch1.manifest?.actresses, ['new stage name', 'ここあ', '新人ちゃん']);

        const preview1 = evaluateManifestPerformers(db, m1.id);
        assert.equal(preview1.canCommit, false);
        assert.equal(preview1.autoMatched.length, 1);
        assert.equal(preview1.autoMatched[0]!.tagId, canonicalTag.tagId);
        assert.equal(preview1.autoMatched[0]!.source, 'performer-rule');
        assert.equal(preview1.pendingReview.length, 2);

        const ambiguousItem = preview1.pendingReview.find((p) => p.rawName === 'ここあ');
        const unknownItem = preview1.pendingReview.find((p) => p.rawName === '新人ちゃん');
        assert.equal(ambiguousItem?.reason, 'ambiguous');
        assert.deepEqual(
          ambiguousItem?.candidateTags.map((c) => c.id),
          [cocoaA.tagId, cocoaB.tagId],
        );
        assert.equal(unknownItem?.reason, 'unknown');
        assert.deepEqual(unknownItem?.candidateTags, []);

        // Policy 1: approve normal review, then commit must FAIL with PERFORMER_REVIEW_REQUIRED
        reviewIngestionManifest(db, { manifestId: m1.id, decision: 'approved', newTagNames: ['巨乳'] });
        const blockedCommit = commitIngestionManifest(db, { manifestId: m1.id, roots, fileOps });
        assert.equal(blockedCommit.ok, false);
        assert.equal(blockedCommit.code, 'PERFORMER_REVIEW_REQUIRED');
        assert.equal(fs.existsSync(file1), true, 'Staging file must NOT move while performer review is pending');

        // Re-evaluating the same manifest is idempotent (no duplicate queue rows)
        const preview1Again = evaluateManifestPerformers(db, m1.id);
        assert.equal(preview1Again.pendingReview.length, 2);

        // Resolve ambiguous 'ここあ' -> bind to cocoaB first, then modify to cocoaA before commit!
        const resAmbFirst = resolvePerformerReview(db, {
          reviewId: ambiguousItem!.id,
          mode: 'bind_existing',
          tagId: cocoaB.tagId,
          rememberRule: false,
        });
        assert.equal(resAmbFirst.ok, true);
        assert.equal(resAmbFirst.item?.resolvedTagId, cocoaB.tagId);

        const resAmb = resolvePerformerReview(db, {
          reviewId: ambiguousItem!.id,
          mode: 'bind_existing',
          tagId: cocoaA.tagId,
          rememberRule: false,
        });
        assert.equal(resAmb.ok, true);
        assert.equal(resAmb.item?.resolvedTagId, cocoaA.tagId);

        // Resolve unknown '新人ちゃん' -> create new performer tag (`kind = 'performer'`) and remember durable rule
        const resUnk = resolvePerformerReview(db, {
          reviewId: unknownItem!.id,
          mode: 'create_performer_tag',
          newTagName: '新人ちゃん',
          rememberRule: true,
        });
        assert.equal(resUnk.ok, true);
        assert.ok(resUnk.createdTagId);
        const createdTagRow = db
          .prepare('SELECT kind, name FROM tags WHERE id = ?')
          .get(resUnk.createdTagId) as { kind: string; name: string };
        assert.equal(createdTagRow.kind, 'performer');
        assert.equal(createdTagRow.name, '新人ちゃん');

        // Now preview is ready and commit succeeds!
        const previewReady = evaluateManifestPerformers(db, m1.id);
        assert.equal(previewReady.canCommit, true);
        assert.equal(previewReady.humanResolved.length, 2);
        const committed1 = commitIngestionManifest(db, { manifestId: m1.id, roots, fileOps });
        assert.equal(committed1.ok, true);
        assert.ok(committed1.mediaId);

        // Verify provenance:
        // - canonicalTag -> 'performer-rule' (confidence 1.0)
        // - cocoaA & 新人ちゃん -> 'manual' (Option B: human-confirmed in review queue!)
        // - 巨乳 -> 'ingestion'
        const mediaTags = db
          .prepare('SELECT tag_id, source, confidence FROM media_tags WHERE media_id = ? ORDER BY tag_id ASC')
          .all(committed1.mediaId) as Array<{ tag_id: number; source: string; confidence: number | null }>;
        const byTagId = new Map(mediaTags.map((r) => [Number(r.tag_id), r]));
        assert.equal(byTagId.get(canonicalTag.tagId)?.source, 'performer-rule');
        assert.equal(byTagId.get(canonicalTag.tagId)?.confidence, 1);
        assert.equal(byTagId.get(cocoaA.tagId)?.source, 'manual');
        assert.equal(byTagId.get(cocoaA.tagId)?.confidence, null);
        assert.equal(byTagId.get(resUnk.createdTagId)?.source, 'manual');

        // Audit log distinguishes auto vs human-confirmed performer tags
        const auditRow = db
          .prepare(`SELECT payload_json FROM mutation_log WHERE action = 'ingestion_commit' ORDER BY id DESC LIMIT 1`)
          .get() as { payload_json: string };
        const auditPayload = JSON.parse(auditRow.payload_json) as {
          autoPerformerTagIds: number[];
          humanConfirmedPerformerTagIds: number[];
        };
        assert.deepEqual(auditPayload.autoPerformerTagIds, [canonicalTag.tagId]);
        assert.deepEqual(auditPayload.humanConfirmedPerformerTagIds.sort(), [cocoaA.tagId, resUnk.createdTagId].sort());

        // Automation MUST NOT remove existing manual associations (`B4`)
        const autoRm = removeAutomatedMediaTags(db, {
          actor: 'performer-rule',
          mediaIds: [committed1.mediaId],
          tagIds: [cocoaA.tagId, canonicalTag.tagId],
        });
        assert.equal(autoRm.ok, true);
        if (autoRm.ok) {
          assert.equal(autoRm.removed, 1, 'Only performer-rule tag may be removed by performer-rule actor');
          assert.equal(autoRm.skipped, 1, 'Manual tag must be protected and skipped');
        }

        // Re-commit is idempotent
        const replay1 = commitIngestionManifest(db, { manifestId: m1.id, roots, fileOps });
        assert.equal(replay1.ok, true);
        assert.equal(replay1.idempotentReplay, true);

        // 2) Durable reuse on later manifest (file2): '新人ちゃん' now auto-matches deterministically!
        const m2 = ensureManifestForStagingFile(db, {
          tempPath: file2,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });
        await fetchMetadataForManifest(db, m2.id, makeMockCmadbFetcher('5003320', 'Video 2', ['新人ちゃん']));
        const preview2 = evaluateManifestPerformers(db, m2.id);
        assert.equal(preview2.canCommit, true);
        assert.equal(preview2.autoMatched.length, 1);
        assert.equal(preview2.autoMatched[0]!.tagId, resUnk.createdTagId);
        assert.equal(preview2.autoMatched[0]!.source, 'performer-rule');

        reviewIngestionManifest(db, { manifestId: m2.id, decision: 'approved', newTagNames: ['巨乳'] });
        const committed2 = commitIngestionManifest(db, { manifestId: m2.id, roots, fileOps });
        assert.equal(committed2.ok, true);
        assert.ok(committed2.mediaId);

        // Promote auto-applied `performer-rule` association to `manual`
        const promoted = promotePerformerTagToManual(db, {
          mediaId: String(committed2.mediaId),
          tagId: resUnk.createdTagId,
        });
        assert.equal(promoted.ok, true);
        assert.equal(promoted.promoted, true);
        const afterPromote = db
          .prepare('SELECT source, confidence FROM media_tags WHERE media_id = ? AND tag_id = ?')
          .get(committed2.mediaId, resUnk.createdTagId) as { source: string; confidence: number | null };
        assert.equal(afterPromote.source, 'manual');
        assert.equal(afterPromote.confidence, null);

        // 3) Policy `always_ask` forces review even when only 1 active tag is mapped
        const soloTag = createTag(db, { name: 'Mina Solo' });
        assert.equal(soloTag.ok, true);
        if (!soloTag.ok) return;
        upsertPerformerAlias(db, { rawAlias: 'みな', tagId: soloTag.tagId, policy: 'always_ask' });
        const m3 = ensureManifestForStagingFile(db, {
          tempPath: file3,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });
        await fetchMetadataForManifest(db, m3.id, makeMockCmadbFetcher('5009999', 'Video 3', ['みな']));
        const preview3 = evaluateManifestPerformers(db, m3.id);
        assert.equal(preview3.canCommit, false);
        assert.equal(preview3.pendingReview[0]?.reason, 'ambiguous');
        assert.equal(preview3.pendingReview[0]?.candidateTags[0]?.id, soloTag.tagId);

        // Overriding an autoMatched performer via (manifestId + rawName) works cleanly before commit.
        const skipAuto = resolvePerformerReview(db, {
          manifestId: m3.id,
          rawName: 'みな',
          mode: 'skip',
        });
        assert.equal(skipAuto.ok, true);
        const preview3Skipped = evaluateManifestPerformers(db, m3.id);
        assert.equal(preview3Skipped.canCommit, true);
        assert.equal(preview3Skipped.skippedEntries.length, 1);
        assert.equal(preview3Skipped.skippedEntries[0]?.rawName, 'みな');
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('B5: rename preserves mappings, merge migrates & dedupes performer_aliases, and archive surfaces remediation', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-perf-b5-'));
    try {
      const { tempDir, dbPath, roots, fileOps } = setupEnv(tmpDir);
      const sampleFile = path.join(tempDir, 'FC2-PPV-5008888.mp4');
      fs.writeFileSync(sampleFile, 'video-b5');

      const db = new DatabaseSync(dbPath);
      try {
        await migrateDatabase(db, { dbPath, appVersion: '0.6.0' });
        db.prepare(
          `INSERT INTO media_roots (id, name, canonical_unc_root, enabled, created_at)
           VALUES ('nas-main', 'NAS', ?, 1, '2026-11-18T00:00:00.000Z')`,
        ).run(roots[0]!.canonicalUncRoot);

        const tagA = createTag(db, { name: 'Actress A' });
        const tagB = createTag(db, { name: 'Actress B' });
        const tagC = createTag(db, { name: 'Actress C' });
        assert.equal(tagA.ok && tagB.ok && tagC.ok, true);
        if (!tagA.ok || !tagB.ok || !tagC.ok) return;

        upsertPerformerAlias(db, { rawAlias: 'alias-shared', tagId: tagA.tagId, policy: 'auto' });
        upsertPerformerAlias(db, { rawAlias: 'alias-shared', tagId: tagB.tagId, policy: 'always_ask' });
        upsertPerformerAlias(db, { rawAlias: 'alias-only-b', tagId: tagB.tagId, policy: 'auto' });
        upsertPerformerAlias(db, { rawAlias: 'alias-c', tagId: tagC.tagId, policy: 'auto' });

        // Rename tagA -> mapping remains valid by tag_id
        const renamed = renameTag(db, { tagId: tagA.tagId, name: 'Actress A Renamed', expectedRevision: tagA.revision });
        assert.equal(renamed.ok, true);
        if (!renamed.ok) return;
        const afterRename = listPerformerAliases(db).find((a) => a.tagId === tagA.tagId);
        assert.equal(afterRename?.tagName, 'Actress A Renamed');

        // Merge preview reports performer aliases to migrate (1) and dedupe (1)
        const preview = previewMerge(db, { targetTagId: tagA.tagId, sourceTagId: tagB.tagId });
        assert.equal(preview.ok, true);
        if (!preview.ok) return;
        assert.equal(preview.performerAliasesMigrated, 1);
        assert.equal(preview.performerAliasesDeduped, 1);

        const merged = mergeTags(db, {
          targetTagId: tagA.tagId,
          sourceTagId: tagB.tagId,
          expectedTargetRevision: preview.targetRevision,
          expectedSourceRevision: preview.sourceRevision,
        });
        assert.equal(merged.ok, true);
        if (!merged.ok) return;
        assert.equal(merged.performerAliasesMigrated, 1);
        assert.equal(merged.performerAliasesDeduped, 1);

        const aliasesAfterMerge = listPerformerAliases(db);
        const migratedB = aliasesAfterMerge.find((a) => a.normalizedName === 'alias-only-b');
        assert.equal(migratedB?.tagId, tagA.tagId);
        const dedupedShared = aliasesAfterMerge.filter((a) => a.normalizedName === 'alias-shared');
        assert.equal(dedupedShared.length, 1);
        assert.equal(dedupedShared[0]?.tagId, tagA.tagId);
        assert.equal(dedupedShared[0]?.policy, 'always_ask', 'Deduped merge preserves stricter always_ask policy');

        // Archive tagC -> surfaces needsRemediation in listPerformerAliases AND routes manifest to archived_target review
        const archived = archiveTag(db, { tagId: tagC.tagId, expectedRevision: tagC.revision });
        assert.equal(archived.ok, true);
        const aliasC = listPerformerAliases(db).find((a) => a.normalizedName === 'alias-c');
        assert.equal(aliasC?.targetArchived, true);
        assert.equal(aliasC?.needsRemediation, true);

        const m = ensureManifestForStagingFile(db, {
          tempPath: sampleFile,
          targetRootId: 'nas-main',
          targetSubdir: 'ingested',
          roots,
          fileOps,
        });
        await fetchMetadataForManifest(db, m.id, makeMockCmadbFetcher('5008888', 'Archived Target Test', ['alias-c']));
        const evalArchived = evaluateManifestPerformers(db, m.id);
        assert.equal(evalArchived.canCommit, false);
        assert.equal(evalArchived.pendingReview[0]?.reason, 'archived_target');

        // Deleting an obsolete alias succeeds cleanly
        const delRes = deletePerformerAlias(db, { aliasId: aliasC!.id });
        assert.equal(delRes.ok, true);
        assert.equal(listPerformerReviewQueue(db, { status: 'pending' }).length, 1);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('upgrades an existing v5 database cleanly to v6 with performer_aliases, performer_review_queue, and actresses_json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-perf-v5-to-v6-'));
    try {
      const { dbPath, roots } = setupEnv(tmpDir);
      const db = new DatabaseSync(dbPath);
      try {
        const v5Only = DEFAULT_MIGRATIONS.filter((m) => m.version <= 5);
        const resV5 = await migrateDatabase(db, { dbPath, appVersion: '0.5.5', migrations: v5Only });
        assert.equal(resV5.currentVersion, 5);
      } finally {
        db.close();
      }

      const service = new MediaLibrarySpikeService({
        baseDir: tmpDir,
        dbPath,
        roots,
        autoDailyBackup: false,
      });
      assert.deepEqual(await service.listPerformerAliases(), []);
      assert.deepEqual(await service.listPerformerReviewQueue({ status: 'pending' }), []);

      const dbAfter = new DatabaseSync(dbPath);
      try {
        const vRow = dbAfter.prepare('SELECT MAX(version) AS v FROM schema_versions').get() as { v: number };
        assert.equal(vRow.v, 6);
        const cols = dbAfter.prepare('PRAGMA table_info(ingestion_manifests)').all() as Array<{ name: string }>;
        assert.ok(cols.some((c) => c.name === 'actresses_json'));
      } finally {
        dbAfter.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
