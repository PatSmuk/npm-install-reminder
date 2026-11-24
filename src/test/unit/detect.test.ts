// Synthetic fixtures, no network: the edge cases real installs are awkward to reproduce.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { checkRoot, findInstallRoots, fingerprint, summarize } from '../../detect';
import { git, tempDir, writeJson } from '../fixture';

/** Writes a package.json, a lockfile, and node_modules/.package-lock.json listing `installed`. */
function lockfileProject(opts: {
  deps?: Record<string, string>;
  devDeps?: Record<string, string>;
  locked: Record<string, object>;
  installed: Record<string, object>;
}): string {
  const dir = tempDir('nir-unit-');
  const manifest = { dependencies: opts.deps ?? {}, devDependencies: opts.devDeps ?? {} };
  writeJson(path.join(dir, 'package.json'), { name: 'p', version: '1.0.0', ...manifest });
  writeJson(path.join(dir, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: { '': { name: 'p', version: '1.0.0', ...manifest }, ...opts.locked },
  });
  writeJson(path.join(dir, 'node_modules/.package-lock.json'), { lockfileVersion: 3, packages: opts.installed });
  return dir;
}

const check = async (dir: string) => (await checkRoot({ dir, mode: 'lockfile' })).map((p) => `${p.kind}: ${p.detail}`);

test('findInstallRoots: npm roots, skips workspace members, yarn projects, and node_modules', async () => {
  const repo = tempDir('nir-roots-');
  git(repo, 'init', '-q');
  writeJson(path.join(repo, 'package.json'), { workspaces: ['packages/*'] });
  writeJson(path.join(repo, 'package-lock.json'), {
    lockfileVersion: 3,
    packages: { '': {}, 'packages/a': {}, 'node_modules/a': { link: true, resolved: 'packages/a' } },
  });
  writeJson(path.join(repo, 'packages/a/package.json'), {});
  writeJson(path.join(repo, 'apps/yarn-app/package.json'), {});
  fs.writeFileSync(path.join(repo, 'apps/yarn-app/yarn.lock'), '');
  writeJson(path.join(repo, 'apps/yarn-app/sub/package.json'), {});
  writeJson(path.join(repo, 'legacy/package.json'), {});
  writeJson(path.join(repo, 'tools/cli/package.json'), {});
  writeJson(path.join(repo, 'tools/cli/npm-shrinkwrap.json'), {});
  writeJson(path.join(repo, 'vendored/node_modules/x/package.json'), {});
  writeJson(path.join(repo, 'untracked/package.json'), {});
  git(repo, 'add', '-f', '--', ':!untracked');

  assert.deepEqual(await findInstallRoots(repo), [
    { dir: repo, mode: 'lockfile' },
    { dir: path.join(repo, 'legacy'), mode: 'manifest' },
    { dir: path.join(repo, 'tools/cli'), mode: 'lockfile' },
  ]);
});

test('missing optional, devOptional, peer and bundled packages are fine', async () => {
  const dir = lockfileProject({
    deps: { esbuild: '0.20.0' },
    locked: {
      'node_modules/esbuild': { version: '0.20.0' },
      'node_modules/@esbuild/win32-x64': { version: '0.20.0', optional: true, os: ['win32'] },
      'node_modules/fsevents': { version: '2.3.3', devOptional: true },
      'node_modules/react': { version: '18.3.1', peer: true },
      'node_modules/esbuild/node_modules/bundled': { version: '1.0.0', inBundle: true },
    },
    installed: { 'node_modules/esbuild': { version: '0.20.0' } },
  });
  assert.deepEqual(await check(dir), []);
});

test('version, nested and git-commit changes are reported; registry host changes are not', async () => {
  const dir = lockfileProject({
    deps: { a: '^1.0.0', g: 'github:o/g', r: '1.0.0' },
    locked: {
      'node_modules/a': { version: '1.2.0' },
      'node_modules/a/node_modules/b': { version: '2.0.0' },
      'node_modules/g': { version: '1.0.0', resolved: 'git+ssh://git@github.com/o/g.git#bbbb' },
      'node_modules/r': { version: '1.0.0', resolved: 'https://registry.npmjs.org/r/-/r-1.0.0.tgz' },
    },
    installed: {
      'node_modules/a': { version: '1.1.0' },
      'node_modules/a/node_modules/b': { version: '1.0.0' },
      'node_modules/g': { version: '1.0.0', resolved: 'git+ssh://git@github.com/o/g.git#aaaa' },
      'node_modules/r': { version: '1.0.0', resolved: 'https://npm.mirror.example/r/-/r-1.0.0.tgz' },
    },
  });
  assert.deepEqual(await check(dir), [
    'changed: a is 1.1.0 but the lockfile wants 1.2.0',
    'changed: a/node_modules/b is 1.0.0 but the lockfile wants 2.0.0',
    'changed: g comes from git+ssh://git@github.com/o/g.git#aaaa but the lockfile wants git+ssh://git@github.com/o/g.git#bbbb',
  ]);
});

test('dev deps: missing ones count only when some dev deps are installed', async () => {
  const locked = {
    'node_modules/x': { version: '1.0.0', dev: true },
    'node_modules/y': { version: '1.0.0', dev: true },
  };
  const omitDev = lockfileProject({ devDeps: { x: '1.0.0', y: '1.0.0' }, locked, installed: {} });
  assert.deepEqual(await check(omitDev), []);
  const partial = lockfileProject({ devDeps: { x: '1.0.0', y: '1.0.0' }, locked, installed: { 'node_modules/x': { version: '1.0.0' } } });
  assert.deepEqual(await check(partial), ['missing: y@1.0.0 is not installed']);
});

test('package.json vs lockfile root entry', async () => {
  const dir = lockfileProject({ deps: { a: '^1.0.0' }, locked: {}, installed: {} });
  writeJson(path.join(dir, 'package.json'), { name: 'p', dependencies: { a: '^2.0.0', c: '1.0.0' }, devDependencies: {} });
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  lock.packages[''].devDependencies = { gone: '1.0.0' };
  writeJson(path.join(dir, 'package-lock.json'), lock);
  assert.deepEqual(await check(dir), [
    'manifest: package.json wants a@^2.0.0 in dependencies, but the lockfile has ^1.0.0',
    "manifest: package.json adds c@1.0.0 to dependencies, which the lockfile doesn't have",
    'manifest: package.json drops gone from devDependencies, but the lockfile still has it',
  ]);
});

test('manifest mode (no lockfile): presence plus exact versions, resolving up the tree', async () => {
  const parent = tempDir('nir-manifest-');
  const dir = path.join(parent, 'app');
  writeJson(path.join(dir, 'package.json'), {
    dependencies: { here: '1.0.0', hoisted: '^2.0.0', ranged: '^3.0.0', gone: '1.0.0' },
  });
  writeJson(path.join(dir, 'node_modules/here/package.json'), { version: '1.0.1' });
  writeJson(path.join(dir, 'node_modules/ranged/package.json'), { version: '4.0.0' });
  writeJson(path.join(parent, 'node_modules/hoisted/package.json'), { version: '2.5.0' });
  assert.deepEqual(
    (await checkRoot({ dir, mode: 'manifest' })).map((p) => p.detail),
    ['here is 1.0.1 but package.json wants 1.0.0', 'gone@1.0.0 is not installed'],
  );
});

test('a lockfile with merge-conflict markers falls back to manifest checks', async () => {
  const dir = lockfileProject({ deps: { a: '1.0.0' }, locked: {}, installed: {} });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> feat\n');
  assert.deepEqual(await check(dir), ['missing: a@1.0.0 is not installed']);
});

test('summarize and fingerprint', () => {
  const problems = [
    { kind: 'changed' as const, detail: 'b' },
    { kind: 'changed' as const, detail: 'a' },
    { kind: 'missing' as const, detail: 'c' },
    { kind: 'manifest' as const, detail: 'd' },
  ];
  assert.equal(summarize(problems), '2 packages at the wrong version, 1 missing, 1 package.json change not in the lockfile');
  assert.equal(fingerprint(problems), fingerprint([...problems].reverse()));
});
