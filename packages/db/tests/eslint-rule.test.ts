// WBS 0.11 (pg-tester). RED phase: the lint rule doesn't exist yet — the import below fails to
// resolve until pg-backend builds packages/db/eslint-rules/no-db-outside-with-context.js. That
// import-resolution failure IS the correct RED for this file (see with-context.test.ts header for
// why this task genuinely has a RED phase, unlike WBS 0.9/0.10).
//
// Rule under test enforces CLAUDE.md · ARCHITECTURE ("A lint rule fails the build on any db.* call
// outside" withContext) and doc 40 line 32/80 (quoted in the WBS 0.11 brief): P5 — "One write path;
// every mutation passes the validation layer | Lint: no `db.` outside `withContext()`." — the
// package's raw `db` export (imported from '@pg-eos/db') must never have a method called on it
// directly; only the scoped handle passed into a withContext(...) callback may be used. Every
// fixture below names that scoped handle `tx` (never `db`), per the brief, so the "risky bare `db`
// import" case and the "safe scoped handle" case can never be confused with each other.
//
// No live database needed — this is a pure ESLint RuleTester unit test of the rule's AST logic.

import { Linter, RuleTester } from 'eslint';
import { describe, it } from 'vitest';

// The rule module doesn't exist yet (WBS 0.11 RED) — pg-backend builds it next. Extension assumed
// `.js` with a default export, matching this repo's `"type": "module"` + NodeNext convention used
// by every other package (see eslint.config.mjs itself, an ESM file, importing plugins the same
// way) — flagged as an open question in the WBS 0.11 REPORT in case pg-backend needs a different
// extension or a named export instead.
import noDbOutsideWithContext from '../eslint-rules/no-db-outside-with-context.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

describe('no-db-outside-with-context (WBS 0.11 — CLAUDE.md P5 / doc 40 line 32 & 80)', () => {
  it('RuleTester valid/invalid fixtures', () => {
    ruleTester.run('no-db-outside-with-context', noDbOutsideWithContext, {
      valid: [
        // The raw `db` export used only as a value (passed around, never called) is not a
        // violation — nothing was ever invoked on it directly.
        {
          code: `
            import { db } from '@pg-eos/db';
            function useIt(runner) {
              return runner(db);
            }
          `,
        },
        // A completely unrelated 'db' that is NOT the tracked import — property access on some
        // other object that merely happens to also be named 'db'. Must never be flagged: the rule
        // tracks the imported binding from '@pg-eos/db', not the bare identifier text 'db'
        // anywhere in the file.
        {
          code: `
            something.db.query('select 1');
          `,
        },
        // The scoped handle passed into withContext's callback — named 'tx', never 'db', in every
        // fixture in this file. Calling methods on it is exactly what withContext exists to allow
        // and must never be flagged.
        {
          code: `
            import { withContext } from '@pg-eos/db';
            withContext(ctx, async (tx) => {
              await tx.query('select 1');
            });
          `,
        },
      ],
      invalid: [
        // Module top-level: the raw db export, called directly, outside any withContext callback.
        {
          code: `
            import { db } from '@pg-eos/db';
            db.query('select 1');
          `,
          errors: [{ message: /withContext/ }],
        },
        // Nested inside an ordinary function — still outside any withContext(...) call, still a
        // violation. CLAUDE.md's rule has no exception for being wrapped in a function that isn't
        // itself a withContext callback.
        {
          code: `
            import { db } from '@pg-eos/db';
            function f() {
              db.select('*');
            }
          `,
          errors: [{ message: /withContext/ }],
        },
      ],
    });
  });

  it('reports exactly one error naming withContext for the module-top-level violation (direct Linter cross-check, independent of RuleTester internals)', () => {
    const linter = new Linter();
    const messages = linter.verify(
      `
        import { db } from '@pg-eos/db';
        db.query('select 1');
      `,
      {
        languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
        plugins: {
          local: { rules: { 'no-db-outside-with-context': noDbOutsideWithContext } },
        },
        rules: { 'local/no-db-outside-with-context': 'error' },
      },
    );

    if (messages.length !== 1) {
      throw new Error(
        `expected exactly one lint message, got ${messages.length}: ${JSON.stringify(messages)}`,
      );
    }
    const [message] = messages;
    if (!message || !/withContext/.test(message.message)) {
      throw new Error(
        `expected the lint message to name 'withContext', got: ${JSON.stringify(message)}`,
      );
    }
  });

  it('reports exactly one error naming withContext for the nested-function violation (direct Linter cross-check)', () => {
    const linter = new Linter();
    const messages = linter.verify(
      `
        import { db } from '@pg-eos/db';
        function f() {
          db.select('*');
        }
      `,
      {
        languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
        plugins: {
          local: { rules: { 'no-db-outside-with-context': noDbOutsideWithContext } },
        },
        rules: { 'local/no-db-outside-with-context': 'error' },
      },
    );

    if (messages.length !== 1) {
      throw new Error(
        `expected exactly one lint message, got ${messages.length}: ${JSON.stringify(messages)}`,
      );
    }
    const [message] = messages;
    if (!message || !/withContext/.test(message.message)) {
      throw new Error(
        `expected the lint message to name 'withContext', got: ${JSON.stringify(message)}`,
      );
    }
  });
});
