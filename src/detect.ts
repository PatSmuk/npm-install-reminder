// Decides whether a directory's node_modules matches what its package.json /
// package-lock.json ask for. No `vscode` import, so it runs under plain Node tests.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * `lockfile`: compare node_modules against package-lock.json (exact).
 * `manifest`: no npm lockfile, so only check package.json deps are present.
 */
export type CheckMode = 'lockfile' | 'manifest';

export interface InstallRoot {
  /** Absolute directory that holds package.json (and node_modules once installed). */
  dir: string;
  mode: CheckMode;
}

export type ProblemKind = 'missing' | 'changed' | 'manifest';

export interface Problem {
  kind: ProblemKind;
  detail: string;
}

type DepMap = Record<string, string>;

interface LockEntry {
  version?: string;
  resolved?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  peer?: boolean;
  inBundle?: boolean;
  [field: string]: unknown;
}

interface Lockfile {
  packages?: Record<string, LockEntry>;
}

interface Installed {
  version?: string;
  resolved?: string;
}

const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
const NPM_LOCKFILES = ['npm-shrinkwrap.json', 'package-lock.json'];
const OTHER_LOCKFILES = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];

/**
 * Finds every directory in the repo that npm installs into, from the files git
 * tracks. npm workspace members are covered by their root's lockfile, and
 * yarn/pnpm/bun projects are left alone. `gitPath` is the git executable to run.
 */
export async function findInstallRoots(repoRoot: string, gitPath = 'git'): Promise<InstallRoot[]> {
  const names = ['package.json', ...NPM_LOCKFILES, ...OTHER_LOCKFILES];
  const { stdout } = await execFileAsync(
    gitPath,
    ['ls-files', '-z', '--', ...names.map((n) => `:(glob)**/${n}`)],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  );

  const pkgDirs = new Set<string>();
  const npmLockDirs = new Set<string>();
  const otherLockDirs = new Set<string>();
  for (const file of stdout.split('\0')) {
    if (!file || file.split('/').includes('node_modules')) continue;
    const dir = path.posix.dirname(file);
    const base = path.posix.basename(file);
    if (base === 'package.json') pkgDirs.add(dir);
    else if (NPM_LOCKFILES.includes(base)) npmLockDirs.add(dir);
    else otherLockDirs.add(dir);
  }

  // npm workspace members are the lockfile's non-node_modules keys ("packages/a").
  const workspaceMembers = new Set<string>();
  for (const lockDir of npmLockDirs) {
    for (const name of NPM_LOCKFILES) {
      const lock = await readJson<Lockfile>(path.join(repoRoot, lockDir, name));
      if (!lock?.packages) continue;
      for (const key of Object.keys(lock.packages)) {
        if (key !== '' && !isInstallPath(key)) workspaceMembers.add(path.posix.join(lockDir, key));
      }
      break;
    }
  }

  const roots: InstallRoot[] = [];
  for (const dir of [...pkgDirs].sort()) {
    const abs = path.join(repoRoot, dir);
    if (npmLockDirs.has(dir)) {
      roots.push({ dir: abs, mode: 'lockfile' });
      continue;
    }
    if (workspaceMembers.has(dir)) continue; // checked through its root's lockfile
    if (ancestors(dir).some((d) => otherLockDirs.has(d))) continue; // yarn/pnpm/bun project
    roots.push({ dir: abs, mode: 'manifest' });
  }
  return roots;
}

export async function hasNodeModules(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(dir, 'node_modules'))).isDirectory();
  } catch {
    return false;
  }
}

/** Returns what's out of date in `root`; empty means `npm install` would change nothing that matters. */
export async function checkRoot(root: InstallRoot): Promise<Problem[]> {
  const pkg = await readJson<Record<string, unknown>>(path.join(root.dir, 'package.json'));
  if (!pkg) return [];
  if (root.mode === 'lockfile') {
    for (const name of NPM_LOCKFILES) {
      const lock = await readJson<Lockfile>(path.join(root.dir, name));
      if (lock?.packages) return checkAgainstLockfile(root.dir, pkg, lock.packages);
    }
    // lockfileVersion 1 or an unparseable lockfile (e.g. conflict markers): do what we can.
  }
  return checkAgainstManifest(root.dir, pkg);
}

/** Short human summary, e.g. "2 packages at the wrong version, 1 missing". */
export function summarize(problems: Problem[]): string {
  const count = (kind: ProblemKind) => problems.filter((p) => p.kind === kind).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const parts: string[] = [];
  const changed = count('changed');
  const missing = count('missing');
  const manifest = count('manifest');
  if (changed) parts.push(`${plural(changed, 'package')} at the wrong version`);
  if (missing) parts.push(`${missing} missing`);
  if (manifest) parts.push(`${plural(manifest, 'package.json change')} not in the lockfile`);
  return parts.join(', ');
}

/** Stable identity for a set of problems, so the same mismatch isn't reported twice. */
export function fingerprint(problems: Problem[]): string {
  return problems
    .map((p) => `${p.kind}:${p.detail}`)
    .sort()
    .join('\n');
}

async function checkAgainstLockfile(
  dir: string,
  pkg: Record<string, unknown>,
  packages: Record<string, LockEntry>,
): Promise<Problem[]> {
  const problems: Problem[] = [];

  // 1. package.json files vs. what the lockfile was generated from.
  compareManifest('package.json', pkg, packages[''] ?? {}, problems);
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '' || isInstallPath(key)) continue; // remaining keys are workspace members
    const member = await readJson<Record<string, unknown>>(path.join(dir, key, 'package.json'));
    if (member) compareManifest(`${key}/package.json`, member, entry, problems);
  }

  // 2. node_modules vs. the lockfile. npm 7+ keeps a copy of what it installed in
  //    node_modules/.package-lock.json; without it, read each package's package.json.
  const hidden = await readJson<Lockfile>(path.join(dir, 'node_modules', '.package-lock.json'));
  const lookup: (key: string) => Promise<Installed | undefined> = hidden?.packages
    ? async (key) => hidden.packages![key]
    : async (key) => {
        const p = await readJson<Record<string, unknown>>(path.join(dir, key, 'package.json'));
        return p && { version: typeof p.version === 'string' ? p.version : undefined };
      };

  const wanted = Object.entries(packages).filter(([key]) => isInstallPath(key));
  const installed = await mapLimit(wanted, 32, ([key]) => lookup(key));

  const missingDev: Problem[] = [];
  let devInstalled = false;
  wanted.forEach(([key, want], i) => {
    const have = installed[i];
    const name = displayName(key);
    if (!have) {
      // Optional/platform-specific, peer-only, and bundled packages can legitimately be absent.
      if (want.optional || want.devOptional || want.peer || want.inBundle) return;
      const problem: Problem = { kind: 'missing', detail: `${name}@${want.version ?? want.resolved ?? '?'} is not installed` };
      (want.dev ? missingDev : problems).push(problem);
      return;
    }
    if (want.dev) devInstalled = true;
    if (want.link) {
      if (have.resolved && want.resolved && have.resolved !== want.resolved) {
        problems.push({ kind: 'changed', detail: `${name} links to ${have.resolved} but the lockfile wants ${want.resolved}` });
      }
      return;
    }
    if (want.version && have.version !== want.version) {
      problems.push({ kind: 'changed', detail: `${name} is ${have.version ?? 'an unknown version'} but the lockfile wants ${want.version}` });
    } else if (
      // Same version from a different git commit or local path. Registry URLs are
      // skipped: a mirror registry rewrites them without changing the package.
      want.resolved &&
      have.resolved &&
      want.resolved !== have.resolved &&
      !/^https?:/.test(want.resolved)
    ) {
      problems.push({ kind: 'changed', detail: `${name} comes from ${have.resolved} but the lockfile wants ${want.resolved}` });
    }
  });
  // Missing dev deps only count if dev deps were installed at all (not `npm install --omit=dev`).
  if (devInstalled) problems.push(...missingDev);
  return problems;
}

async function checkAgainstManifest(dir: string, pkg: Record<string, unknown>): Promise<Problem[]> {
  const problems: Problem[] = [];
  const missingDev: Problem[] = [];
  let devInstalled = false;
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const [name, spec] of Object.entries(asDepMap(pkg[field]))) {
      const have = await resolveInstalled(dir, name);
      if (!have) {
        const problem: Problem = { kind: 'missing', detail: `${name}@${spec} is not installed` };
        (field === 'devDependencies' ? missingDev : problems).push(problem);
        continue;
      }
      if (field === 'devDependencies') devInstalled = true;
      // Without a lockfile only exact versions can be checked without a semver library.
      const exact = spec.replace(/^[=v]/, '');
      if (/^\d+\.\d+\.\d+(?:[-+][\w.+-]*)?$/.test(exact) && have.version !== exact) {
        problems.push({ kind: 'changed', detail: `${name} is ${have.version ?? 'an unknown version'} but package.json wants ${exact}` });
      }
    }
  }
  if (devInstalled) problems.push(...missingDev);
  return problems;
}

/** Node-style lookup: node_modules/<name> here or in any parent directory. */
async function resolveInstalled(dir: string, name: string): Promise<Installed | undefined> {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = await readJson<Record<string, unknown>>(path.join(d, 'node_modules', name, 'package.json'));
    if (p) return { version: typeof p.version === 'string' ? p.version : undefined };
    if (path.dirname(d) === d) return undefined;
  }
}

function compareManifest(file: string, pkg: Record<string, unknown>, locked: LockEntry, problems: Problem[]): void {
  for (const field of MANIFEST_FIELDS) {
    const want = asDepMap(pkg[field]);
    const have = asDepMap(locked[field]);
    for (const name of new Set([...Object.keys(want), ...Object.keys(have)])) {
      const w = want[name];
      const h = have[name];
      if (w === h) continue;
      const detail =
        h === undefined
          ? `${file} adds ${name}@${w} to ${field}, which the lockfile doesn't have`
          : w === undefined
            ? `${file} drops ${name} from ${field}, but the lockfile still has it`
            : `${file} wants ${name}@${w} in ${field}, but the lockfile has ${h}`;
      problems.push({ kind: 'manifest', detail });
    }
  }
}

function isInstallPath(key: string): boolean {
  return key.startsWith('node_modules/') || key.includes('/node_modules/');
}

function displayName(key: string): string {
  return key.replace(/^node_modules\//, '');
}

function ancestors(dir: string): string[] {
  const out = [dir];
  for (let d = dir; d !== '.'; ) {
    d = path.posix.dirname(d);
    out.push(d);
  }
  return out;
}

function asDepMap(value: unknown): DepMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: DepMap = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
