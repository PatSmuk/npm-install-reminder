import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Keep the developer's global git config (signing, hooks) out of fixture repos.
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: 'pipe' });
}

export function npm(cwd: string, ...args: string[]): void {
  execFileSync('npm', [...args, '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], { cwd, stdio: 'pipe' });
}

/** realpath'd so paths match what git reports (/var -> /private/var on macOS). */
export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * A repo with node_modules installed for `main`, plus:
 *   docs - only README changes
 *   feat - is-number 7.0.0 -> 6.0.0, adds is-odd
 */
export function createBranchFixture(): string {
  const dir = tempDir('nir-branches-');
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  writeJson(path.join(dir, 'package.json'), {
    name: 'fixture',
    version: '1.0.0',
    private: true,
    dependencies: { 'is-number': '7.0.0' },
    devDependencies: { 'left-pad': '1.3.0', isarray: '2.0.5' },
  });
  npm(dir, 'install');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'main');

  git(dir, 'checkout', '-qb', 'docs');
  fs.appendFileSync(path.join(dir, 'README.md'), 'more docs\n');
  git(dir, 'commit', '-qam', 'docs');

  git(dir, 'checkout', '-q', 'main');
  git(dir, 'checkout', '-qb', 'feat');
  const pkg = readJson(path.join(dir, 'package.json'));
  pkg.dependencies = { 'is-number': '6.0.0', 'is-odd': '3.0.1' };
  writeJson(path.join(dir, 'package.json'), pkg);
  npm(dir, 'install');
  git(dir, 'commit', '-qam', 'feat deps');

  git(dir, 'checkout', '-q', 'main');
  npm(dir, 'install');
  return dir;
}
