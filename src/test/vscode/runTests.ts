// Launches a separate VS Code instance (own profile, other extensions disabled)
// on a fixture repo and runs ./suite inside it.
import { runTests } from '@vscode/test-electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createBranchFixture, tempDir } from '../fixture';

const INSTALLED = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';

async function main(): Promise<void> {
  const fixture = createBranchFixture();
  const profile = tempDir('nir-vscode-profile-');
  try {
    await runTests({
      // Use the installed VS Code if there is one; otherwise test-electron downloads one.
      vscodeExecutablePath: process.env.VSCODE_PATH ?? (!process.env.CI && fs.existsSync(INSTALLED) ? INSTALLED : undefined),
      extensionDevelopmentPath: path.resolve(__dirname, '../../..'),
      extensionTestsPath: path.resolve(__dirname, 'suite'),
      launchArgs: [fixture, '--disable-extensions', '--user-data-dir', profile, '--new-window'],
    });
  } finally {
    // Windows can hold file locks for a moment after VS Code exits.
    const rm = (dir: string) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    rm(profile);
    rm(fixture);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
