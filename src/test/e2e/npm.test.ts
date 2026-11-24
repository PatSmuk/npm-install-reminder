// Real npm installs (needs the npm registry): checks the detector against what npm actually writes.
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { before, test } from 'node:test';
import { checkRoot, findInstallRoots, InstallRoot } from '../../detect';
import { createBranchFixture, git, npm, readJson, tempDir, writeJson } from '../fixture';

let repo: string;
let root: InstallRoot;
const details = async () => (await checkRoot(root)).map((p) => `${p.kind}: ${p.detail}`);

before(async () => {
  repo = createBranchFixture();
  const roots = await findInstallRoots(repo);
  assert.deepEqual(roots, [{ dir: repo, mode: 'lockfile' }]);
  root = roots[0];
});

test('fresh install on main is up to date', async () => {
  assert.deepEqual(await details(), []);
});

test('branch with only a README change is up to date', async () => {
  git(repo, 'checkout', '-q', 'docs');
  assert.deepEqual(await details(), []);
  git(repo, 'checkout', '-q', 'main');
});

test('switching to a branch with different deps is out of date', async () => {
  git(repo, 'checkout', '-q', 'feat');
  assert.deepEqual((await details()).sort(), [
    'changed: is-number is 7.0.0 but the lockfile wants 6.0.0',
    'missing: is-odd@3.0.1 is not installed',
  ]);
});

test('npm install on the branch clears it', async () => {
  npm(repo, 'install');
  assert.deepEqual(await details(), []);
});

test('switching back flags the version change but not the leftover package', async () => {
  git(repo, 'checkout', '-q', 'main');
  assert.deepEqual(await details(), ['changed: is-number is 6.0.0 but the lockfile wants 7.0.0']);
  npm(repo, 'install');
  assert.deepEqual(await details(), []);
});

test('without node_modules/.package-lock.json it reads installed package.json files', async () => {
  git(repo, 'checkout', '-q', 'feat');
  fs.rmSync(path.join(repo, 'node_modules', '.package-lock.json'));
  assert.deepEqual((await details()).sort(), [
    'changed: is-number is 7.0.0 but the lockfile wants 6.0.0',
    'missing: is-odd@3.0.1 is not installed',
  ]);
  git(repo, 'checkout', '-q', 'main');
  npm(repo, 'install');
  assert.deepEqual(await details(), []);
});

test('install with --omit=dev does not complain about dev deps', async () => {
  fs.rmSync(path.join(repo, 'node_modules'), { recursive: true });
  npm(repo, 'install', '--omit=dev');
  assert.ok(!fs.existsSync(path.join(repo, 'node_modules', 'left-pad')));
  assert.deepEqual(await details(), []);
  npm(repo, 'install');
});

test('missing dev dep is reported when dev deps are installed', async () => {
  fs.rmSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true });
  fs.rmSync(path.join(repo, 'node_modules', '.package-lock.json'));
  assert.deepEqual(await details(), ['missing: left-pad@1.3.0 is not installed']);
  npm(repo, 'install');
});

test('package.json edited without updating the lockfile', async () => {
  const file = path.join(repo, 'package.json');
  const original = fs.readFileSync(file, 'utf8');
  const pkg = JSON.parse(original);
  pkg.dependencies['is-odd'] = '^3.0.0';
  writeJson(file, pkg);
  assert.deepEqual(await details(), ["manifest: package.json adds is-odd@^3.0.0 to dependencies, which the lockfile doesn't have"]);
  fs.writeFileSync(file, original);
});

test('peerDependencies on the root package are recorded in the lockfile as-is', async () => {
  const dir = tempDir('nir-peer-');
  writeJson(path.join(dir, 'package.json'), {
    name: 'peer-fixture',
    version: '1.0.0',
    dependencies: { 'is-number': '7.0.0' },
    peerDependencies: { 'is-number': '>=6' },
  });
  npm(dir, 'install');
  assert.deepEqual(await checkRoot({ dir, mode: 'lockfile' }), []);
});

test('npm workspaces: one root, member package.json changes are caught', async () => {
  const dir = tempDir('nir-ws-');
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  writeJson(path.join(dir, 'package.json'), { name: 'ws-root', private: true, workspaces: ['packages/*'] });
  writeJson(path.join(dir, 'packages/a/package.json'), { name: 'a', version: '1.0.0', dependencies: { 'is-number': '7.0.0' } });
  writeJson(path.join(dir, 'packages/b/package.json'), { name: 'b', version: '1.0.0', dependencies: { a: '1.0.0' } });
  npm(dir, 'install');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'ws');

  assert.deepEqual(await findInstallRoots(dir), [{ dir, mode: 'lockfile' }]);
  const ws: InstallRoot = { dir, mode: 'lockfile' };
  assert.deepEqual(await checkRoot(ws), []);
  assert.equal(readJson(path.join(dir, 'node_modules/.package-lock.json')).packages['node_modules/a'].link, true);

  const member = path.join(dir, 'packages/a/package.json');
  const pkg = readJson(member);
  pkg.dependencies['is-number'] = '6.0.0';
  writeJson(member, pkg);
  assert.deepEqual(
    (await checkRoot(ws)).map((p) => p.detail),
    ['packages/a/package.json wants is-number@6.0.0 in dependencies, but the lockfile has 7.0.0'],
  );
});
