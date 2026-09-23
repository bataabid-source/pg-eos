// PG-EOS · install-hooks.mjs — points git at the versioned hooks in .githooks/ (CLAUDE.md · GIT, B4).
// Runs from the root `prepare` script on every `pnpm install`; silently does nothing outside a git checkout.
import { execFileSync } from 'node:child_process';

try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
} catch {
  // not a git checkout (e.g. an exported tarball in CI) — hooks are enforced by CI gate ① there
}
