// Type declaration for the plain-ESM no-db-outside-with-context.js rule module (WBS 0.11).
// Paired .d.ts alongside the .js implementation so TypeScript's NodeNext resolver can type the
// `import noDbOutsideWithContext from '../eslint-rules/no-db-outside-with-context.js'` in
// tests/eslint-rule.test.ts without converting the rule itself to TypeScript (ESLint 9 flat-config
// rules are conventionally plain ESM .js — see the header of eslint-rule.test.ts).

import type { Rule } from 'eslint';

declare const rule: Rule.RuleModule;
export default rule;
