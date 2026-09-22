// Flat ESLint config — WBS 0.4.
// The one rule this file exists for (CLAUDE.md · ARCHITECTURE):
//   "Modular monolith; hexagonal per module; cross-module imports fail lint."
//
// A module border can be crossed in three ways, and each resolves differently, so each needs its
// own enforcement. scripts/check-boundaries.sh exercises all three and fails if any stops firing.
//   1. package name   '@pg-eos/platform'          → no-restricted-imports  (paths + group)
//   2. relative path   '../../platform/domain/x.js'
//        · resolvable  → boundaries/dependencies  (classifies the resolved file)
//        · unresolvable (typo, deleted file, .js → .ts rewrite the resolver cannot follow)
//                      → no-restricted-imports (regex) — boundaries cannot classify what it
//                        cannot resolve, and would silently allow it.
//
// Inline config is off repo-wide: CLAUDE.md · AGENT CONSTRAINTS bans `eslint-disable`, so the
// boundary rule must not be switchable off by a comment. With noInlineConfig the directive
// suppresses nothing and reportUnusedDisableDirectives then makes the comment itself an error.

import { readdirSync } from 'node:fs';

import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

import noDbOutsideWithContext from './packages/db/eslint-rules/no-db-outside-with-context.js';

/** Module packages, read from disk so a new module is covered the day it is created. */
const MODULES = readdirSync('modules', { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const SOURCE = ['apps/**/*.{ts,tsx}', 'modules/**/*.{ts,tsx}', 'packages/**/*.{ts,tsx}'];

// The lintable AGENT CONSTRAINTS (doc 40 §A5) and the withContext rule apply to `tests/**` too,
// which SOURCE deliberately does not cover: SOURCE is also the boundaries `include`, and `tests/*`
// is not a boundaries element (no module/app/package pattern matches it), so widening SOURCE
// itself would silently change what the boundaries rule inspects. Tests under `modules/*/tests/`
// were already covered by SOURCE's `modules/**`; the root `tests/` tree (WBS 0.18's
// `tests/isolation`, doc 40 Part F's G14 runner) is the first TypeScript outside it and would
// otherwise have been exempt from `no-console` and `ban-ts-comment` repo-wide. It does NOT, on its
// own, give `local/no-db-outside-with-context` any purchase on tests/isolation's own RLS-bypassing
// calls: that rule only tracks the `db` binding imported from `@pg-eos/db` (packages/db/eslint-
// rules/no-db-outside-with-context.js), and tests/isolation/tests/client-isolation.test.ts never
// imports `db` — its superuser fixture client is a raw `pg.Client`, deliberately outside `db`'s
// pooled/withContext path (see that file's own header comment), so the rule has nothing to flag
// there either way. What this widening actually buys `local/no-db-outside-with-context` is coverage
// for any FUTURE test file under `tests/**` that does import `db` directly instead of going through
// `withContext` — which, absent this widening, would have been invisible to the rule entirely.
const AGENT_CONSTRAINED = [...SOURCE, 'tests/**/*.{ts,tsx}'];

/** Every way of naming another module from inside modules/<self>. */
function crossModuleImports(self) {
  const others = MODULES.filter((name) => name !== self);
  if (others.length === 0) return [];

  const message =
    `Cross-module import: modules/${self} may not import another module directly. ` +
    'Cross-module communication goes through packages/events (domain events) or ' +
    'packages/contracts (shared types) — CLAUDE.md · ARCHITECTURE.';

  // '../platform/x', '../../platform/x', '../../../modules/platform/x' — any depth, resolvable
  // or not. Anchored at the start so it cannot match a path segment inside this module.
  const relativeEscape = `^(?:[.][.]/)+(?:modules/)?(?:${others.join('|')})(?:/|$)`;

  return [
    {
      files: [`modules/${self}/**/*.{ts,tsx}`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: others.map((name) => ({ name: `@pg-eos/${name}`, message })),
            patterns: [
              { group: others.map((name) => `@pg-eos/${name}/*`), message },
              { regex: relativeEscape, message },
            ],
          },
        ],
      },
    },
  ];
}

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.turbo/**',
      '**/coverage/**',
      // Each `.claude/worktrees/<id>` is a separate git worktree of this same repo (a concurrent
      // Claude Code session on its own branch). Left unignored, its nested tsconfig.json/eslint
      // config make typescript-eslint's project discovery ambiguous ("multiple candidate
      // TSConfigRootDirs") for every file in THIS checkout too — not just the worktree's own
      // files. Each worktree lints itself independently when its own session runs `pnpm lint`.
      '.claude/worktrees/**',
      'docs/**',
      'database/**',
      'infra/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ── no opting out of any of the above ──────────────────────────────────────
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
    },
  },

  // ── agent constraints that are lintable, doc 40 §A5 ────────────────────────
  {
    files: AGENT_CONSTRAINED,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      'no-console': 'error',
    },
  },

  // ── all DB access goes through withContext(ctx, fn), CLAUDE.md · ARCHITECTURE ──────────────
  // packages/db/** itself is excluded: its own client.ts/with-context.ts implementation IS the
  // safe path (the plumbing the rule protects), not a caller that needs to route through it.
  {
    files: AGENT_CONSTRAINED,
    ignores: ['packages/db/**'],
    plugins: { local: { rules: { 'no-db-outside-with-context': noDbOutsideWithContext } } },
    rules: {
      'local/no-db-outside-with-context': 'error',
    },
  },

  // ── module boundaries, resolvable-path form (eslint-plugin-boundaries v7) ──
  {
    files: SOURCE,
    plugins: { boundaries },
    settings: {
      // Both resolvers, so boundaries can follow the two import forms NodeNext TypeScript
      // produces: '@pg-eos/x' (workspace link) and '../../x/domain/y.js' (.ts rewritten to .js).
      // What neither resolver can follow is caught by the regex above, not left to chance.
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: ['tsconfig.json'] },
        node: { extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'] },
      },
      'boundaries/include': SOURCE,
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/*', capture: ['app'] },
        { type: 'module', pattern: 'modules/*', capture: ['module'] },
        { type: 'package', pattern: 'packages/*', capture: ['package'] },
      ],
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          message:
            'Forbidden dependency: {{from.type}} → {{to.type}}. A module may import only its own ' +
            'files and packages/*; cross-module communication goes through packages/events ' +
            '(domain events) or packages/contracts (shared types) — CLAUDE.md · ARCHITECTURE.',
          policies: [
            {
              from: { element: { type: 'app' } },
              allow: { to: { element: { types: { anyOf: ['module', 'package'] } } } },
            },
            {
              from: { element: { type: 'module' } },
              allow: {
                to: {
                  element: [
                    { type: 'module', captured: { module: '{{from.module}}' } },
                    { type: 'package' },
                  ],
                },
              },
            },
            {
              from: { element: { type: 'package' } },
              allow: { to: { element: { type: 'package' } } },
            },
          ],
        },
      ],
    },
  },

  // ── module boundaries, package-name and unresolvable forms ─────────────────
  ...MODULES.flatMap(crossModuleImports),
);
