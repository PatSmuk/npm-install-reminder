# npm install Reminder

A VS Code extension that warns you when a branch switch leaves `node_modules` out of date.

When HEAD moves in any open git repository (a checkout from VS Code or a terminal, a pull, or a rebase), it checks every npm project in that repo and, if anything changed, shows:

> Switched to feat: node_modules is out of date in my-app (1 package at the wrong version, 1 missing).  
> [Run npm install] [Show Details]

**Run npm install** opens a terminal in each affected directory and runs the command. **Show Details** opens the *npm install Reminder* output channel, which lists every package that differs.

## What counts as out of date

The extension compares what's on disk; it doesn't just check whether the lockfile changed. Switching to a branch and back without installing in between gives no warning, because `node_modules` matches again.

- **Projects with `package-lock.json` / `npm-shrinkwrap.json`:** every package in the lockfile is compared with npm's record of what it installed (`node_modules/.package-lock.json`). It falls back to reading each installed `package.json` when that record is missing. The check catches:
  - a package at a different version
  - a missing package
  - a git dependency resolved to a different commit
  - a `package.json` (including npm workspace members) that disagrees with the lockfile
- **Projects without a lockfile:** each dependency in `package.json` must be installed, and exact versions (`1.2.3`) must match. Ranges aren't checked.

### What doesn't trigger a warning

- A directory with no `node_modules` at all. You never installed there, so there's nothing to go stale.
- A missing optional, platform-specific, peer-only or bundled package.
- Missing dev dependencies when none are installed, as after `npm install --omit=dev`.
- Leftover packages that the new branch no longer uses.
- A registry URL that differs only by host, such as from a mirror.
- yarn, pnpm and bun projects.
- The same problem reported twice. After you dismiss a warning, committing on the same branch won't raise it again until the mismatch changes.

The extension finds projects from the `package.json` files that git tracks, so it skips untracked ones.

## Commands and settings

- **npm install Reminder: Check Whether npm install Is Needed**: runs the check now, from the command palette.
- `npmInstallReminder.installCommand` (default `npm install`): the command the button runs, for example `npm ci`.

## Development

```sh
npm install
npm test              # unit tests on synthetic fixtures, no network
npm run test:e2e      # real npm installs and branch switches (needs the registry)
npm run test:vscode   # opens a separate VS Code instance (throwaway profile) on a fixture repo
npm run package       # builds npm-install-reminder-<version>.vsix
code --install-extension npm-install-reminder-0.1.0.vsix
```

It relies on the built-in `vscode.git` extension and has no runtime dependencies.
