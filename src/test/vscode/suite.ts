// Runs inside the VS Code extension host. Switches branches with plain `git`
// (as a terminal user would) and asserts which switches raise the warning.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { Notice, ReminderApi } from '../../extension';
import { git } from '../fixture';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Long enough for the git extension to notice HEAD moved and the debounce to fire. */
const QUIET_MS = 6_000;

export async function run(): Promise<void> {
  const repo = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const ext = vscode.extensions.getExtension<ReminderApi>('local.npm-install-reminder')!;
  const api = await ext.activate();
  await waitFor(() => api.watchedRepositories().includes(repo), 'the fixture repo to be watched');
  await sleep(2_000); // let the git extension finish its initial status

  const notices: Notice[] = [];
  api.onDidNotify((n) => notices.push(n));

  const step = (name: string) => console.log(`  - ${name}`);

  step('main -> docs (README only): no warning');
  git(repo, 'checkout', '-q', 'docs');
  await sleep(QUIET_MS);
  assert.equal(notices.length, 0, JSON.stringify(notices));

  step('docs -> feat (deps changed): warning');
  git(repo, 'checkout', '-q', 'feat');
  await waitFor(() => notices.length === 1, 'the warning after switching to feat');
  const [notice] = notices;
  console.log(`    "${notice.message}"`);
  assert.match(notice.message, /^Switched to feat: node_modules is out of date in nir-branches-\w+ \(/);
  assert.match(notice.message, /1 package at the wrong version, 1 missing/);
  assert.equal(notice.roots[0].dir, repo);

  step('feat -> main (node_modules matches main again): no warning');
  git(repo, 'checkout', '-q', 'main');
  await sleep(QUIET_MS);
  assert.equal(notices.length, 1, JSON.stringify(notices.slice(1)));

  step('main -> feat again: warning again (it was cleared in between)');
  git(repo, 'checkout', '-q', 'feat');
  await waitFor(() => notices.length === 2, 'the second warning');

  step('commit on feat with the same stale node_modules: not repeated');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'noop');
  await sleep(QUIET_MS);
  assert.equal(notices.length, 2, JSON.stringify(notices.slice(2)));

  step('"Check Whether npm install Is Needed" command reports it on demand');
  await vscode.commands.executeCommand('npmInstallReminder.checkNow');
  assert.equal(notices.length, 3);
  assert.match(notices[2].message, /^Manual check: /);

  console.log('  all integration checks passed');
}
