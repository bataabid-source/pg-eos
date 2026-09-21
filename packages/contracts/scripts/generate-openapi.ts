// packages/contracts/scripts/generate-openapi.ts — WBS 0.13 (rework round 2, finding 1).
// Writes openapi/openapi.json from a given registry (brief "Deliver" list, D5).
//
// `writeOpenApiDocument` is the testable export tests/openapi-document.test.ts imports directly:
// it takes its own `registry` and `outputPath`, so importing this module under vitest has no
// file-system side effect on the real, committed packages/contracts/openapi/openapi.json. The CLI
// entrypoint below — the only code path that touches that real path — is gated behind Node's
// standard "run as main" check, so merely importing this module never triggers it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registry as productionRegistry } from '../index.js';
import type { ContractRegistry, OpenApiDocument } from '../_shared/registry.js';
import { serializeOpenApiDocument } from '../_shared/serialize.js';

/**
 * Runs `registry.checkInvariants()` before writing anything (finding 1). If any violation exists,
 * throws a plain `Error` listing every violation's method, path, and message, and writes nothing.
 * Otherwise computes `registry.toOpenApiDocument()`, creates `outputPath`'s directory if needed,
 * writes the serialized document (2-space indent + trailing newline — finding 17) to `outputPath`,
 * and returns the document.
 */
export function writeOpenApiDocument(registry: ContractRegistry, outputPath: string): OpenApiDocument {
  const violations = registry.checkInvariants();

  if (violations.length > 0) {
    const detail = violations
      .map((violation) => `${violation.method} ${violation.path}: ${violation.message}`)
      .join('\n');
    throw new Error(
      `Refusing to write the OpenAPI document: ${violations.length} registry invariant ` +
        `violation(s):\n${detail}`,
    );
  }

  const document = registry.toOpenApiDocument();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, serializeOpenApiDocument(document), 'utf8');
  return document;
}

// CLI entrypoint — gated behind Node's "run as main" check (finding 1) so importing this module
// (as tests/openapi-document.test.ts now does) never has a side effect. `process.cwd()` (finding
// 18, not `import.meta.url`-relative resolution) is correct here because the documented
// `generate:openapi` npm script always runs with cwd = the package root via `pnpm --filter`,
// regardless of whether it runs compiled (dist/scripts/) or, hypothetically, from source
// (scripts/) — a directory-depth-relative resolution would silently break in the latter case.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputPath = resolve(process.cwd(), 'openapi', 'openapi.json');
  writeOpenApiDocument(productionRegistry, outputPath);
}
