import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_M1_ROOT_ID,
  MediaLibrarySpikeService,
  classifyFsError,
  defaultUncFileProbe,
} from '../../src/spike-service.ts';
import type { MediaRootConfig } from '../../src/types.ts';
import {
  normalizeCanonicalUncRoot,
  resolveAllowlistedUncPath,
} from '../../src/unc-path.ts';

describe('Host UNC Root & Path Containment (B1)', () => {
  const roots: readonly MediaRootConfig[] = [
    {
      rootId: DEFAULT_M1_ROOT_ID,
      label: 'Primary NAS Share',
      canonicalUncRoot: '\\\\SynologyNAS\\MediaLibrary',
      enabled: true,
    },
    {
      rootId: 'nas-disabled',
      label: 'Disabled Archive Share',
      canonicalUncRoot: '\\\\SynologyNAS\\Archive',
      enabled: false,
    },
  ];

  it('normalizes valid canonical Windows UNC roots and extended-length UNC roots', () => {
    const basic = normalizeCanonicalUncRoot('  \\\\SynologyNAS\\MediaLibrary\\  ');
    assert.equal(basic.ok, true);
    if (basic.ok) {
      assert.equal(basic.canonicalRoot, '\\\\SynologyNAS\\MediaLibrary');
    }

    const nested = normalizeCanonicalUncRoot('\\\\192.168.50.10\\video\\sub_library');
    assert.equal(nested.ok, true);
    if (nested.ok) {
      assert.equal(nested.canonicalRoot, '\\\\192.168.50.10\\video\\sub_library');
    }

    const extended = normalizeCanonicalUncRoot('\\\\?\\UNC\\SynologyNAS\\MediaLibrary');
    assert.equal(extended.ok, true);
    if (extended.ok) {
      assert.equal(extended.canonicalRoot, '\\\\?\\UNC\\SynologyNAS\\MediaLibrary');
    }
  });

  it('rejects drive letters, single-segment roots, traversal segments, and empty strings in UNC roots', () => {
    assert.equal(normalizeCanonicalUncRoot('').ok, false);
    assert.equal(normalizeCanonicalUncRoot('Z:\\MediaLibrary').ok, false);
    assert.equal(normalizeCanonicalUncRoot('\\\\SynologyNAS').ok, false);
    assert.equal(normalizeCanonicalUncRoot('\\\\SynologyNAS\\..\\OtherShare').ok, false);
    assert.equal(normalizeCanonicalUncRoot('/mnt/nas/media').ok, false);
    assert.equal(normalizeCanonicalUncRoot('\\\\SynologyNAS\\Media\0Library').ok, false);
  });

  it('resolves valid relative paths strictly inside the allowlisted UNC root', () => {
    const res = resolveAllowlistedUncPath(
      roots,
      DEFAULT_M1_ROOT_ID,
      '2026\\动画归档\\part 1, scene 2 [1080p].mkv',
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(
        res.resolvedUncPath,
        '\\\\SynologyNAS\\MediaLibrary\\2026\\动画归档\\part 1, scene 2 [1080p].mkv',
      );
    }
  });

  it('rejects unmapped and disabled rootIds', () => {
    const unmapped = resolveAllowlistedUncPath(roots, 'unknown-root', 'movies\\a.mkv');
    assert.equal(unmapped.ok, false);
    if (!unmapped.ok) {
      assert.equal(unmapped.code, 'UNMAPPED_ROOT');
    }

    const disabled = resolveAllowlistedUncPath(roots, 'nas-disabled', 'movies\\a.mkv');
    assert.equal(disabled.ok, false);
    if (!disabled.ok) {
      assert.equal(disabled.code, 'DISABLED_ROOT');
    }
  });

  it('rejects traversal attempts (..), drive-letter injection, leading slashes, and NUL bytes', () => {
    const traversalCases = [
      '..\\secret.mkv',
      'movies\\..\\..\\OtherShare\\secret.mkv',
      '.\\movies\\a.mkv',
      '\\movies\\a.mkv',
      '\\\\EvilServer\\Share\\payload.mkv',
      'C:\\Windows\\System32\\cmd.exe',
      'Z:movies\\a.mkv',
    ];

    for (const badRel of traversalCases) {
      const res = resolveAllowlistedUncPath(roots, DEFAULT_M1_ROOT_ID, badRel);
      assert.equal(res.ok, false, `Expected traversal rejection for: ${badRel}`);
      if (!res.ok) {
        assert.equal(res.code, 'PATH_TRAVERSAL_REJECTED');
      }
    }

    const invalidCases = ['', '   ', 'movies\\bad\0file.mkv', 'movies\\\\double-slash.mkv'];
    for (const badRel of invalidCases) {
      const res = resolveAllowlistedUncPath(roots, DEFAULT_M1_ROOT_ID, badRel);
      assert.equal(res.ok, false, `Expected invalid relative path rejection for: ${badRel}`);
      if (!res.ok) {
        assert.equal(res.code, 'INVALID_RELATIVE_PATH');
      }
    }
  });
});

describe('MediaLibrarySpikeService Open, Reveal & Error Semantics (B2, B3, B4, B5)', () => {
  it('opens and reveals all M1 special-character and >260-char UNC scenarios via mediaId', async () => {
    const openedPaths: string[] = [];
    const revealedPaths: string[] = [];

    const service = new MediaLibrarySpikeService({
      baseDir: '/tmp/dsh-m1-test-home',
      configuredUncRoot: '\\\\SynologyNAS\\MediaLibrary',
      fileProbe: async () => ({ ok: true }),
      opener: {
        async openPath(targetPath) {
          openedPaths.push(targetPath);
        },
        async revealPath(targetPath) {
          revealedPaths.push(targetPath);
        },
      },
    });

    const status = service.getSpikeStatus();
    assert.equal(status.nodeSqliteAvailable, true);
    assert.equal(status.activeUncRoot, '\\\\SynologyNAS\\MediaLibrary');
    assert.ok(status.localDatabasePath.endsWith(path.join('media-library', 'library.sqlite3')));
    assert.ok(!status.localDatabasePath.startsWith('\\\\'));

    const targetIds = [
      'm1-basic-mkv',
      'm1-spaces-mp4',
      'm1-cjk-mkv',
      'm1-comma-mkv',
      'm1-long-path-mkv',
    ];

    for (const mediaId of targetIds) {
      const openRes = await service.openMedia(mediaId);
      assert.equal(openRes.ok, true, `openMedia failed for ${mediaId}`);
      const revealRes = await service.revealMedia(mediaId);
      assert.equal(revealRes.ok, true, `revealMedia failed for ${mediaId}`);
    }

    assert.equal(openedPaths.length, 5);
    assert.equal(revealedPaths.length, 5);

    // Check spaces
    assert.ok(openedPaths[1]?.includes('Folder With Spaces\\Sample Video With Spaces.mp4'));
    // Check CJK
    assert.ok(openedPaths[2]?.includes('动画归档\\测试目录\\中文文件名测试_01.mkv'));
    // Check comma
    assert.ok(revealedPaths[3]?.includes('director, cut\\part 1, scene 2 [1080p].mkv'));
    // Check long path > 260 characters
    assert.ok((openedPaths[4]?.length ?? 0) > 260);
  });

  it('rejects raw UNC paths passed as mediaId and returns structured error codes for NAS failures', async () => {
    const service = new MediaLibrarySpikeService({
      baseDir: '/tmp/dsh-m1-test-home',
      configuredUncRoot: '\\\\SynologyNAS\\MediaLibrary',
      fileProbe: async (resolvedPath) => {
        if (resolvedPath.includes('__non_existent_m1_spike_target__')) {
          return {
            ok: false,
            code: 'FILE_NOT_FOUND',
            message: `Missing file: ${resolvedPath}`,
          };
        }
        return { ok: true };
      },
      opener: {
        async openPath() {
          throw new Error('PotPlayer launch failed');
        },
        async revealPath() {},
      },
    });

    // Attempting to pass a raw UNC path instead of a registered mediaId
    const rawPathAttempt = await service.openMedia(
      '\\\\SynologyNAS\\MediaLibrary\\movies\\sample-basic.mkv',
    );
    assert.equal(rawPathAttempt.ok, false);
    if (!rawPathAttempt.ok) {
      assert.equal(rawPathAttempt.code, 'UNKNOWN_MEDIA_ID');
    }

    // Missing file scenario
    const missingRes = await service.openMedia('m1-missing-file');
    assert.equal(missingRes.ok, false);
    if (!missingRes.ok) {
      assert.equal(missingRes.code, 'FILE_NOT_FOUND');
    }

    // Opener failure scenario
    const openerFailRes = await service.openMedia('m1-basic-mkv');
    assert.equal(openerFailRes.ok, false);
    if (!openerFailRes.ok) {
      assert.equal(openerFailRes.code, 'OPENER_FAILED');
    }
  });

  it('classifies ENOENT, EACCES, and ETIMEDOUT/EHOSTUNREACH errors and respects local m1-spike.json overrides', async () => {
    const enoent = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    assert.equal(classifyFsError(enoent, '\\\\NAS\\Share\\a.mkv').code, 'FILE_NOT_FOUND');

    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    assert.equal(classifyFsError(eacces, '\\\\NAS\\Share\\a.mkv').code, 'PERMISSION_DENIED');

    const etimedout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    assert.equal(
      classifyFsError(etimedout, '\\\\NAS\\Share\\a.mkv').code,
      'NAS_OFFLINE_OR_TIMEOUT',
    );

    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-m1-override-'));
    try {
      const dataDir = path.join(tmpBase, 'media-library');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, 'm1-spike.json'),
        JSON.stringify({
          uncRoot: '\\\\CustomNAS\\RealShare',
        }),
        'utf8',
      );

      const service = new MediaLibrarySpikeService({
        baseDir: tmpBase,
        fileProbe: async () => ({ ok: true }),
        opener: {
          async openPath() {},
          async revealPath() {},
        },
      });

      const status = service.getSpikeStatus();
      assert.equal(status.activeUncRoot, '\\\\CustomNAS\\RealShare');

      const openRes = await service.openMedia('m1-basic-mkv');
      assert.equal(openRes.ok, true);
      if (openRes.ok) {
        assert.equal(
          openRes.resolvedUncPath,
          '\\\\CustomNAS\\RealShare\\movies\\sample-basic.mkv',
        );
      }
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it('probes real missing path via defaultUncFileProbe without hanging', async () => {
    const res = await defaultUncFileProbe('/nonexistent-dsh-m1-path/missing.mkv', 200);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'FILE_NOT_FOUND');
  });

  it('produces a self-contained bundle/lib/typert.host.js manifest validated by @deepseek-ai/dsh-typert-loader', async () => {
    const { TYPERT } = await import('../../bundle/lib/typert.host.js');
    const harnessDir =
      process.env.DSH_HARNESS_DIR ??
      (fs.existsSync('/home/aaevi/projects/project/deepseek-harness')
        ? '/home/aaevi/projects/project/deepseek-harness'
        : '/home/aaevi/projects/deepseek-harness');
    const { validateTypertManifest } = await import(
      `${harnessDir}/packages/typert/loader/src/index.ts`
    );
    const validated = validateTypertManifest(
      '@deepseek-ai/dsh-experimental-media-library',
      TYPERT,
    );
    assert.equal(validated.package, '@deepseek-ai/dsh-experimental-media-library');
    assert.equal(validated.face, 'host');
    assert.equal(validated.invocations.length, 35);
    for (const inv of TYPERT.invocations) {
      for (const param of inv.parameters ?? []) {
        if (param?.codec?.create) assert.ok(param.codec.create());
        if (param?.strictCodec?.create) assert.ok(param.strictCodec.create());
      }
      if (inv.result?.create) assert.ok(inv.result.create());
    }
  });
});
