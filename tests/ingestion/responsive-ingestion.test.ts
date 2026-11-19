import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { MediaLibrarySpikeService, type SpikeServiceOptions } from '../../src/spike-service.ts';
import { defaultIngestionFileOps, MetadataFetcher, type IngestionFileOps } from '../../src/ingestion/index.ts';

const cleanups: string[] = [];
afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(overrides: Partial<IngestionFileOps> = {}, options: Partial<SpikeServiceOptions> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-responsive-'));
  cleanups.push(dir);
  const staging = path.join(dir, 'temp');
  const target = path.join(dir, 'ingested');
  fs.mkdirSync(staging);
  const map = (p: string) => p.startsWith('\\\\NAS\\MediaTest')
    ? path.join(dir, p.slice('\\\\NAS\\MediaTest'.length).replaceAll('\\', '/')) : p;
  const ops: IngestionFileOps = {
    exists: p => defaultIngestionFileOps.exists(map(p)),
    statSize: p => defaultIngestionFileOps.statSize(map(p)),
    sha256: p => defaultIngestionFileOps.sha256(map(p)),
    readRange: (p, offset, length) => defaultIngestionFileOps.readRange(map(p), offset, length),
    ensureDir: p => defaultIngestionFileOps.ensureDir(map(p)),
    rename: (a, b) => defaultIngestionFileOps.rename(map(a), map(b)),
    copyFile: (a, b) => defaultIngestionFileOps.copyFile(map(a), map(b)),
    removeFile: p => defaultIngestionFileOps.removeFile(map(p)),
    ...overrides,
  };
  const service = new MediaLibrarySpikeService({
    baseDir: dir, configuredStagingDir: staging, configuredUncRoot: '\\\\NAS\\MediaTest',
    autoDailyBackup: false, ingestionFileOps: ops, ...options,
  });
  const prepare = async (name = 'sample.mp4', bytes = Buffer.from('sample video')) => {
    const source = path.join(staging, name);
    fs.writeFileSync(source, bytes);
    const reviewed = await service.reviewIngestion({ tempPath: source, decision: 'approved', title: name });
    assert.equal(reviewed.ok, true);
    assert.ok(reviewed.manifest);
    return { id: reviewed.manifest.id, source, destination: path.join(target, name) };
  };
  return { service, prepare, ops, dir, staging, target, map };
}

test('Host prohibits EXDEV copying by default and retains the source without content reads', async () => {
  const f = fixture({
    rename() { throw Object.assign(new Error('different volume'), { code: 'EXDEV' }); },
    copyFile() { assert.fail('Copy must not start by default'); },
    sha256() { assert.fail('Disabled copying must not read content'); },
  });
  const item = await f.prepare();
  const result = await f.service.commitIngestion({ manifestId: item.id });
  assert.equal(result.ok, false);
  assert.match(result.message, /copy.*disabled|allowCrossDeviceCopy/i);
  assert.equal(fs.existsSync(item.source), true);
  assert.equal(fs.existsSync(item.destination), false);
});

function gate() {
  let enter!: () => void;
  let release!: () => void;
  return { entered: new Promise<void>(r => { enter = r; }), pending: new Promise<void>(r => { release = r; }), enter: () => enter(), release: () => release() };
}

test('search and task status finish within 500ms while a commit rename remains pending for five seconds', async () => {
  const g = gate();
  let f: ReturnType<typeof fixture>;
  f = fixture({ rename: async (a, b) => {
    g.enter();
    await g.pending;
    await defaultIngestionFileOps.rename(f.map(a), f.map(b));
  } });
  const item = await f.prepare();
  const started = performance.now();
  const commit = f.service.commitIngestion({ manifestId: item.id });
  await g.entered;
  try {
    const queryStart = performance.now();
    await f.service.searchMedia({});
    assert.ok(performance.now() - queryStart < 500, 'search must finish before rename releases');
    const statusStart = performance.now();
    const tasks = await f.service.listIngestionTasks();
    assert.ok(performance.now() - statusStart < 500, 'status must finish before rename releases');
    assert.equal(tasks[0]?.status, 'running');
    await new Promise(r => setTimeout(r, Math.max(0, 5100 - (performance.now() - started))));
    assert.equal((await f.service.listIngestionTasks())[0]?.status, 'running');
  } finally { g.release(); await commit; }
  assert.equal((await commit).ok, true);
  assert.equal(fs.existsSync(item.source), false);
});

test('active commit rejects other commits/reconcile and review/refetch but permits preparing another item', async () => {
  const g = gate();
  const f = fixture({ rename: async (a, b) => { g.enter(); await g.pending; await defaultIngestionFileOps.rename(f.map(a), f.map(b)); } });
  const a = await f.prepare('first.mp4');
  const b = await f.prepare('second.mp4');
  const pending = f.service.commitIngestion({ manifestId: a.id });
  await g.entered;
  try {
    const competing = await f.service.commitIngestion({ manifestId: b.id });
    assert.equal(competing.ok, false);
    assert.equal(competing.code, 'IN_PROGRESS');
    assert.ok(competing.activeTask?.id);
    const reconcile = await f.service.reconcileIngestion();
    assert.equal(reconcile.ok, false);
    assert.equal(reconcile.activeTask?.id, competing.activeTask.id);
    const edit = await f.service.reviewIngestion({ manifestId: a.id, decision: 'rejected', title: 'changed' });
    assert.equal(edit.ok, false);
    assert.equal(edit.code, 'IN_PROGRESS');
    const fetched = await f.service.fetchIngestionMetadata({ manifestId: a.id });
    assert.equal(fetched.ok, false);
    assert.match(fetched.reason, /IN_PROGRESS/);
    const other = await f.service.reviewIngestion({ manifestId: b.id, decision: 'approved', title: 'prepared' });
    assert.equal(other.ok, true);
    assert.equal(other.manifest?.title, 'prepared');
  } finally { g.release(); await pending; }
  assert.equal((await pending).ok, true);
  assert.equal(fs.existsSync(b.source), true, 'busy request must never execute later');
  assert.equal((await f.service.listIngestionTasks()).filter(t => t.op !== 'fetch').length, 1);
});

test('existing target reuse rejects a different tail and preserves source without indexing', async () => {
  const f = fixture();
  const bytes = Buffer.alloc(4 * 1024 * 1024, 7);
  const item = await f.prepare('reuse.mp4', bytes);
  fs.mkdirSync(f.target, { recursive: true });
  bytes[bytes.length - 1] = 8;
  fs.writeFileSync(item.destination, bytes);
  const result = await f.service.commitIngestion({ manifestId: item.id });
  assert.equal(result.ok, false);
  assert.match(result.message, /incomplete|quick.check/i);
  assert.equal(fs.existsSync(item.source), true);
  assert.equal((await f.service.searchMedia({})).items.length, 0);
});

test('cleanup warning remains visible in the durable task after an explicitly verified copy', async () => {
  const f = fixture({
    rename() { throw Object.assign(new Error('different volume'), { code: 'EXDEV' }); },
    removeFile() { throw new Error('permission denied'); },
  }, { allowCrossDeviceCopy: true });
  const item = await f.prepare();
  const result = await f.service.commitIngestion({ manifestId: item.id });
  assert.equal(result.ok, true);
  assert.match(result.warning ?? '', /copied-not-deleted/);
  assert.equal(fs.existsSync(item.source), true);
  assert.deepEqual(fs.readFileSync(item.destination), fs.readFileSync(item.source));
  assert.match((await f.service.listIngestionTasks())[0]!.message, /copied-not-deleted/);
});

test('normal rename and completed-move recovery perform no content reads or copies', async () => {
  let failAfterRename = true;
  const f = fixture({
    sha256() { assert.fail('rename/recovery must not hash'); },
    readRange() { assert.fail('completed rename must not sample'); },
    copyFile() { assert.fail('rename/recovery must not copy'); },
    async rename(a, b) {
      await defaultIngestionFileOps.rename(f.map(a), f.map(b));
      if (failAfterRename) throw new Error('connection lost after move');
    },
  });
  const item = await f.prepare();
  assert.equal((await f.service.commitIngestion({ manifestId: item.id })).ok, false);
  assert.equal(fs.existsSync(item.source), false);
  assert.equal((await f.service.searchMedia({})).items.length, 0);
  const recovery = await f.service.reconcileIngestion();
  assert.equal(recovery.ok, true);
  assert.equal(recovery.movedNotIndexedFixed, 1);
  const again = await f.service.reconcileIngestion();
  assert.equal(again.movedNotIndexedFixed, 0);
  assert.equal((await f.service.searchMedia({})).items.length, 1);
  failAfterRename = false;
  const normal = await f.prepare('normal.mp4');
  assert.equal((await f.service.commitIngestion({ manifestId: normal.id })).ok, true);
  assert.equal((await f.service.commitIngestion({ manifestId: normal.id })).idempotentReplay, true);
  assert.equal((await f.service.searchMedia({})).items.length, 2);
});

for (const fault of ['beginning', 'middle', 'end', 'short', 'error', 'match'] as const) {
  test(`multi-GB existing target quick check: ${fault}; bounded six MiB and conservative cleanup`, async () => {
    const size = 3 * 1024 ** 3;
    const reads: Array<{ path: string; offset: number; length: number }> = [];
    const f = fixture({
      statSize: () => size,
      sha256() { assert.fail('sample reuse must not hash the whole file'); },
      copyFile() { assert.fail('existing target must not be overwritten'); },
      readRange(p, offset, length) {
        reads.push({ path: p, offset, length });
        const buf = Buffer.alloc(length, 1);
        if (p.startsWith('\\\\')) {
          if (fault === 'error') throw new Error('network read failed');
          if (fault === 'short') return buf.subarray(0, length - 1);
          if ((fault === 'beginning' && offset === 0) || (fault === 'middle' && offset > 0 && offset < size / 2) || (fault === 'end' && offset > size / 2)) buf[0] = 2;
        }
        return buf;
      },
    });
    const item = await f.prepare();
    fs.mkdirSync(f.target, { recursive: true });
    fs.copyFileSync(item.source, item.destination);
    const result = await f.service.commitIngestion({ manifestId: item.id });
    assert.equal(result.ok, fault === 'match');
    assert.equal(fs.existsSync(item.source), fault !== 'match');
    assert.equal((await f.service.searchMedia({})).items.length, fault === 'match' ? 1 : 0);
    assert.ok(reads.reduce((sum, read) => sum + read.length, 0) <= 6 * 1024 ** 2);
    if (fault === 'match') {
      assert.deepEqual(reads.filter(r => !r.path.startsWith('\\\\')).map(r => [r.offset, r.length]), [
        [0, 1048576], [1610088448, 1048576], [3220176896, 1048576],
      ]);
      assert.equal(reads.reduce((sum, read) => sum + read.length, 0), 6291456);
    }
  });
}

test('small matching files are compared once per file before reuse', async () => {
  let totalRead = 0;
  const f = fixture({ async readRange(p, offset, length) {
    totalRead += length;
    return defaultIngestionFileOps.readRange(f.map(p), offset, length);
  } });
  const item = await f.prepare();
  fs.mkdirSync(f.target, { recursive: true });
  fs.copyFileSync(item.source, item.destination);
  assert.equal((await f.service.commitIngestion({ manifestId: item.id })).ok, true);
  assert.equal(totalRead, 24);
});

for (const code of ['EACCES', 'EXDEV'] as const) {
  test(`copy policy ${code}: only explicit EXDEV opt-in can copy and verification failure retains source`, async () => {
    let copied = false;
    const f = fixture({
      rename() { throw Object.assign(new Error(code), { code }); },
      async copyFile(a, b) {
        copied = true;
        await defaultIngestionFileOps.copyFile(f.map(a), f.map(b));
        fs.writeFileSync(f.map(b), 'corrupt data');
      },
    }, { allowCrossDeviceCopy: true });
    const item = await f.prepare();
    const result = await f.service.commitIngestion({ manifestId: item.id });
    assert.equal(result.ok, false);
    assert.equal(copied, code === 'EXDEV');
    if (code === 'EXDEV') assert.equal(result.code, 'CHECKSUM_MISMATCH');
    assert.equal(fs.existsSync(item.source), true);
    assert.equal((await f.service.searchMedia({})).items.length, 0);
  });
}

test('30-second warning keeps exclusion and reviewed inputs; phase progress resets warning', async () => {
  let clock = new Date('2026-11-19T00:00:00Z');
  const rename = gate();
  const verify = gate();
  let moved = false;
  const f = fixture({
    async rename(a, b) { rename.enter(); await rename.pending; await defaultIngestionFileOps.rename(f.map(a), f.map(b)); moved = true; },
    async exists(p) { if (moved && p.startsWith('\\\\')) { verify.enter(); await verify.pending; } return defaultIngestionFileOps.exists(f.map(p)); },
  }, { now: () => clock });
  const item = await f.prepare();
  const other = await f.prepare('other.mp4');
  const commit = f.service.commitIngestion({ manifestId: item.id });
  await rename.entered;
  try {
    assert.equal((await f.service.listIngestionTasks())[0]?.phase, 'rename');
    clock = new Date(clock.getTime() + 29999);
    assert.equal((await f.service.listIngestionTasks())[0]?.waitingWarning, false);
    clock = new Date(clock.getTime() + 1);
    const warning = (await f.service.listIngestionTasks())[0]!;
    assert.equal(warning.waitingWarning, true);
    assert.equal(warning.status, 'running');
    assert.equal((await f.service.commitIngestion({ manifestId: other.id })).code, 'IN_PROGRESS');
    const performer = await f.service.resolvePerformerReview({ manifestId: item.id, rawName: 'new performer', mode: 'skip' });
    assert.equal(performer.code, 'IN_PROGRESS');
    rename.release();
    await verify.entered;
    const progressed = (await f.service.listIngestionTasks())[0]!;
    assert.equal(progressed.phase, 'validation');
    assert.equal(progressed.waitingWarning, false);
    assert.equal(progressed.status, 'running');
    assert.equal((await f.service.reconcileIngestion()).ok, false);
  } finally { rename.release(); verify.release(); await commit; }
  assert.equal((await commit).ok, true);
  assert.equal(fs.existsSync(other.source), true);
});

for (const operation of ['probe', 'copy', 'hash', 'reconcile-read'] as const) {
  test(`search/status remain responsive during five-second ${operation}; active recovery also rejects commits`, async () => {
    const g = gate();
    let armed = false;
    const wait = async () => { if (armed) { armed = false; g.enter(); await g.pending; } };
    const f = fixture({
      async exists(p) { if (operation === 'probe' && p.startsWith('\\\\')) await wait(); return defaultIngestionFileOps.exists(f.map(p)); },
      async rename(a, b) {
        if (operation === 'copy' || operation === 'hash' || operation === 'reconcile-read') throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        await defaultIngestionFileOps.rename(f.map(a), f.map(b));
      },
      async copyFile(a, b) { if (operation === 'copy') await wait(); await defaultIngestionFileOps.copyFile(f.map(a), f.map(b)); },
      async sha256(p) { if (operation === 'hash') await wait(); return defaultIngestionFileOps.sha256(f.map(p)); },
      async readRange(p, offset, length) { if (operation === 'reconcile-read') await wait(); return defaultIngestionFileOps.readRange(f.map(p), offset, length); },
    }, { allowCrossDeviceCopy: operation !== 'reconcile-read' });
    const item = await f.prepare();
    const other = await f.prepare('other.mp4');
    if (operation === 'reconcile-read') {
      assert.equal((await f.service.commitIngestion({ manifestId: item.id })).ok, false);
      fs.mkdirSync(f.target, { recursive: true });
      fs.copyFileSync(item.source, item.destination);
    }
    armed = true;
    const started = performance.now();
    const pending = operation === 'reconcile-read' ? f.service.reconcileIngestion() : f.service.commitIngestion({ manifestId: item.id });
    await g.entered;
    try {
      const searchStart = performance.now();
      await f.service.searchMedia({});
      assert.ok(performance.now() - searchStart < 500);
      const statusStart = performance.now();
      const tasks = await f.service.listIngestionTasks();
      assert.ok(performance.now() - statusStart < 500);
      assert.equal(tasks[0]?.status, 'running');
      assert.equal((await f.service.commitIngestion({ manifestId: other.id })).code, 'IN_PROGRESS');
      assert.equal((await f.service.reconcileIngestion()).ok, false);
      await new Promise(r => setTimeout(r, Math.max(0, 5100 - (performance.now() - started))));
      assert.equal((await f.service.listIngestionTasks())[0]?.status, 'running');
    } finally { g.release(); await pending; }
    assert.equal((await pending).ok, true);
    assert.equal(fs.existsSync(other.source), true);
  });
}

test('reconcile refuses incomplete targets and never cleans an unapproved source', async () => {
  const f = fixture({ rename() { throw new Error('network failure'); } });
  const item = await f.prepare();
  assert.equal((await f.service.commitIngestion({ manifestId: item.id })).ok, false);
  fs.mkdirSync(f.target, { recursive: true });
  fs.writeFileSync(item.destination, 'short');
  assert.equal((await f.service.reconcileIngestion()).ok, false);
  fs.copyFileSync(item.source, item.destination);
  fs.writeFileSync(item.destination, 'different!!!');
  const mismatch = await f.service.reconcileIngestion();
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.errors.join(' '), /quick check/);
  const rejected = await f.service.reviewIngestion({ manifestId: item.id, decision: 'rejected' });
  assert.equal(rejected.ok, true);
  await f.service.reconcileIngestion();
  assert.equal(fs.existsSync(item.source), true);
  assert.equal((await f.service.searchMedia({})).items.length, 0);
});

test('Host rejects staging paths outside its configuration before touching files', async () => {
  const f = fixture();
  const outside = path.join(f.dir, 'outside.mp4');
  fs.writeFileSync(outside, 'private');
  await assert.rejects(f.service.reviewIngestion({ tempPath: outside, decision: 'approved' }), /PATH_TRAVERSAL_REJECTED/);
  assert.equal((await f.service.listIngestionManifests()).length, 0);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'private');
});

test('tag changes during a move are revalidated at indexing; failed indexing remains recoverable', async () => {
  const g = gate();
  const f = fixture({ async rename(a, b) { g.enter(); await g.pending; await defaultIngestionFileOps.rename(f.map(a), f.map(b)); } });
  const item = await f.prepare();
  const tag = await f.service.createTag({ name: 'Reviewed tag' });
  assert.equal(tag.ok, true);
  if (!tag.ok) return;
  await f.service.reviewIngestion({ manifestId: item.id, decision: 'approved', tagIds: [tag.tagId] });
  const commit = f.service.commitIngestion({ manifestId: item.id });
  await g.entered;
  try { assert.equal((await f.service.archiveTag({ tagId: tag.tagId, expectedRevision: tag.revision })).ok, true); }
  finally { g.release(); await commit; }
  const result = await commit;
  assert.equal(result.code, 'INDEX_FAILED');
  assert.equal((await f.service.searchMedia({})).items.length, 0);
  const archived = (await f.service.listTags({ includeArchived: true })).tags.find(t => t.id === tag.tagId)!;
  assert.equal((await f.service.restoreTag({ tagId: tag.tagId, expectedRevision: archived.revision })).ok, true);
  assert.equal((await f.service.reconcileIngestion()).movedNotIndexedFixed, 1);
  const media = (await f.service.searchMedia({})).items;
  assert.equal(media.length, 1);
  assert.deepEqual(media[0]!.tags.map(t => t.id), [tag.tagId]);
});

test('completed move cannot register through a disabled Media Root', async () => {
  const roots = [{ rootId: 'nas-main', label: 'fixture', canonicalUncRoot: '\\\\NAS\\MediaTest', enabled: true }];
  const f = fixture({ async rename(a, b) { await defaultIngestionFileOps.rename(f.map(a), f.map(b)); throw new Error('lost response'); } }, { roots });
  const item = await f.prepare();
  assert.equal((await f.service.commitIngestion({ manifestId: item.id })).ok, false);
  roots[0]!.enabled = false;
  const denied = await f.service.reconcileIngestion();
  assert.equal(denied.ok, false);
  assert.equal((await f.service.searchMedia({})).items.length, 0);
  roots[0]!.enabled = true;
  assert.equal((await f.service.reconcileIngestion()).movedNotIndexedFixed, 1);
});

test('schema v6 tasks survive additive migration and restart is interrupted without replay', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { DEFAULT_MIGRATIONS, migrateDatabase } = await import('../../src/db/schema.ts');
  const f = fixture({ rename() { assert.fail('restart must not replay'); }, readRange() { assert.fail('restart must not reconcile'); } });
  const dbPath = path.join(f.dir, 'media-library/library.sqlite3');
  fs.mkdirSync(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  try {
    await migrateDatabase(db, { dbPath, appVersion: '0.6.2', migrations: DEFAULT_MIGRATIONS.filter(m => m.version <= 6) });
    db.prepare("INSERT INTO ingestion_tasks(target_key, op, status, message, started_at) VALUES ('manifest:42', 'commit', 'running', 'Old task', ?)").run('2026-11-18T00:00:00.000Z');
  } finally { db.close(); }
  const tasks = await f.service.listIngestionTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.status, 'interrupted');
  assert.equal(tasks[0]!.startedAt, '2026-11-18T00:00:00.000Z');
  assert.equal(tasks[0]!.phase, 'validation');
  assert.equal(tasks[0]!.phaseStartedAt, tasks[0]!.startedAt);
  const ops = await f.service.getOpsStatus();
  assert.equal(ops.degradedState.schemaVersion, 7);
  assert.equal(ops.degradedState.healthOk, true);
  assert.ok(ops.backups.some(b => b.kind === 'pre-migrate'));
  assert.equal((await f.service.searchMedia({})).items.length, 0);
});

test('executing performer decisions and their alias rules are frozen, while unrelated review stays available', async () => {
  const g = gate();
  const fetcher = new MetadataFetcher({ retries: 0, requestDelayMs: 0, fetchImpl: async () => ({
    ok: true, status: 200, text: async () => '<script data-page="app" type="application/json">{"props":{"actresses":[{"name":"Performer A"}],"article":{"video_id":"1234567","title":"fixture"}}}</script>',
  }) });
  const f = fixture({ async rename(a, b) { g.enter(); await g.pending; await defaultIngestionFileOps.rename(f.map(a), f.map(b)); } }, { metadataFetcher: fetcher });
  const item = await f.prepare('FC2-PPV-1234567.mp4');
  assert.equal((await f.service.fetchIngestionMetadata({ manifestId: item.id })).ok, true);
  const resolved = await f.service.resolvePerformerReview({ manifestId: item.id, rawName: 'Performer A', mode: 'create_performer_tag', rememberRule: true });
  assert.equal(resolved.ok, true);
  const alias = (await f.service.listPerformerAliases())[0]!;
  const pending = f.service.commitIngestion({ manifestId: item.id });
  await g.entered;
  try {
    assert.equal((await f.service.upsertPerformerAlias({ rawAlias: 'PERFORMER A', tagId: alias.tagId, policy: 'always_ask' })).code, 'IN_PROGRESS');
    assert.equal((await f.service.deletePerformerAlias({ aliasId: alias.id })).code, 'IN_PROGRESS');
    assert.equal((await f.service.resolvePerformerReview({ reviewId: resolved.item!.id, mode: 'skip' })).code, 'IN_PROGRESS');
    const other = await f.prepare('other.mp4');
    const unrelated = await f.service.resolvePerformerReview({ manifestId: other.id, rawName: 'Performer B', mode: 'skip' });
    assert.equal(unrelated.ok, true);
    const sameNameSkip = await f.service.resolvePerformerReview({ manifestId: other.id, rawName: 'Performer A', mode: 'skip', rememberRule: true });
    assert.equal(sameNameSkip.ok, true, 'skip changes only the other Manifest, never the remembered alias');
    assert.equal((await f.service.listPerformerAliases())[0]!.policy, 'auto');
  } finally { g.release(); await pending; }
  assert.equal((await pending).ok, true);
  assert.deepEqual((await f.service.searchMedia({})).items[0]!.tags.map(t => t.id), [alias.tagId]);
});
