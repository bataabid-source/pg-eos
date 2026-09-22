// packages/db/eslint-rules/no-db-outside-with-context.js — WBS 0.11 (review round 2).
//
// Flat-config ESLint rule object ({ meta, create(context) {...} }). Enforces CLAUDE.md ·
// ARCHITECTURE ("A lint rule fails the build on any db.* call outside" withContext) and doc 40
// line 32/80, P5: "One write path; every mutation passes the validation layer | Lint: no `db.`
// outside `withContext()`."
//
// There is no legitimate reason to ever call `db.*` (the raw, unscoped drizzle handle) directly
// anywhere in application code — the only sanctioned handle is the callback parameter that
// withContext(ctx, fn) passes to `fn` (named `tx` in every test fixture). `db` is a DIFFERENT,
// unscoped connection with no RLS GUCs set, whether or not the call is textually inside a
// withContext(...) callback. An earlier revision of this rule exempted calls lexically enclosed
// in a withContext(...) callback; that exemption was a real false-negative (nothing legitimate
// ever calls the tracked `db` binding itself from inside such a callback — the callback argument
// is always a different variable) and has been removed outright. Any
// `<trackedDbBinding>.<method>(...)` call is always a violation, full stop — no exceptions.
//
// Detection runs in Program:exit and resolves the tracked import via the scope manager
// (`Variable#references`) rather than a simple two-pass AST visitor keyed on visit order. ESLint
// visits nodes in document order, so a naive "note the import, then flag later CallExpressions"
// approach can never see a `db.*` call that appears (legally — ES imports hoist) textually BEFORE
// its own import statement. Resolving the variable once, after the whole Program has been
// visited, and walking every one of its references finds every use regardless of textual order.
//
// Known, accepted limitation (this is a lint-level check, not taint-tracking): a re-assignment to
// a new variable — `const alias = db; alias.query(...)` — is NOT traced. The real security
// boundary is Postgres RLS plus a correctly configured non-superuser application role, not
// perfect lint soundness against deliberate evasion; see packages/db/src/client.ts for the
// current RLS/superuser gap this depends on.

const PACKAGE_NAME = '@pg-eos/db';

// A relative import resolving to packages/db's barrel — any depth of '../' or './', with or
// without an explicit '/index' and a '.js'/'.ts' extension (e.g. '../../packages/db/index.js').
// Mirrors the relative-path regex pattern already used for cross-module-import enforcement in
// eslint.config.mjs (`crossModuleImports`'s `relativeEscape`).
const RELATIVE_SOURCE_PATTERN = /(?:^|\/)packages\/db(?:\/index(?:\.[jt]s)?)?$/;

function isTrackedImportSource(source) {
  if (source === PACKAGE_NAME) return true;
  const stripped = source.replace(/^(?:[.][.]?\/)+/, '');
  return RELATIVE_SOURCE_PATTERN.test(stripped);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow calling methods on the raw `db` export from @pg-eos/db outside a withContext(ctx, fn) callback.',
    },
    schema: [],
    messages: {
      dbOutsideWithContext:
        "Direct db.* calls are forbidden outside withContext(ctx, fn) — CLAUDE.md · ARCHITECTURE " +
        '("All DB access goes through withContext(ctx, fn)"). Wrap this call in withContext(...) ' +
        "and use the callback's scoped handle instead.",
    },
  },
  create(context) {
    return {
      'Program:exit'(programNode) {
        const sourceCode = context.sourceCode;
        // getScope(Program) always returns the outermost (global) scope by design; the module
        // scope import bindings actually live in is one of its child scopes for ES modules.
        const globalScope = sourceCode.getScope(programNode);
        const moduleScope =
          globalScope.childScopes.find((scope) => scope.type === 'module') ?? globalScope;

        for (const variable of moduleScope.variables) {
          const importDef = variable.defs.find((def) => def.type === 'ImportBinding');
          if (!importDef) continue;

          const specifierNode = importDef.node;
          if (specifierNode.type !== 'ImportSpecifier') continue;

          const importDeclaration = importDef.parent;
          if (
            !importDeclaration ||
            importDeclaration.type !== 'ImportDeclaration' ||
            !isTrackedImportSource(importDeclaration.source.value)
          ) {
            continue;
          }

          const imported = specifierNode.imported;
          const importedName = imported.type === 'Identifier' ? imported.name : imported.value;
          if (importedName !== 'db') continue;

          for (const reference of variable.references) {
            const idNode = reference.identifier;
            const parent = idNode.parent;
            if (!parent || parent.type !== 'MemberExpression' || parent.object !== idNode) {
              continue;
            }

            const callNode = parent.parent;
            if (!callNode || callNode.type !== 'CallExpression' || callNode.callee !== parent) {
              continue;
            }

            context.report({ node: callNode, messageId: 'dbOutsideWithContext' });
          }
        }
      },
    };
  },
};
