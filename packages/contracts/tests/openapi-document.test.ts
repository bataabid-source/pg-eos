// WBS 0.13 — REWORK round 1 of 2 (pg-tester). Encodes the brief's Gherkin scenarios:
//   "The OpenAPI document is generated from the Zod contracts"
//   "The committed document never drifts from the contracts"
//
// Redesigned per reviewer findings 7+8 (docs/notes/0.13-contracts.brief.md rework round 1):
//   - The "generation" describe below never writes to the real tracked
//     packages/contracts/openapi/openapi.json. It calls a testable `writeOpenApiDocument(registry,
//     outputPath)` export from scripts/generate-openapi.ts (pg-backend, round 2 — does not exist
//     yet, hence RED) against a fresh path under os.tmpdir() and asserts against THAT file.
//   - The "drift" describe below never shells out to git or to the generate script. It reads the
//     real committed openapi/openapi.json straight off disk (readFileSync only) and compares it
//     byte-for-byte to a fresh in-memory `registry.toOpenApiDocument()`. It writes nothing, so it
//     can never self-heal — it is genuinely asserting "the committed file matches the registry
//     right now", in any checkout state.
//   - The two describes below share NO file-system side effect any more. Their execution order
//     does not matter. Do not re-couple them by routing one through the other's output.
//
// Finding 3: a new describe (`ContractRegistry#toOpenApiDocument — full route shape`) registers a
// fixture route on a local, throwaway ContractRegistry — not the production `registry` singleton —
// exercising a header param, a path param, a query param, a request body, a 2xx response with a
// body, and a 4xx response using ProblemSchema, and asserts the emitted document actually contains
// that route at the right path+method with the right parameter locations.
//
// Finding 10: a new describe (`ContractRegistry#registerSchema`) proves a schema registered once
// and reused across two routes is emitted as a single `components.schemas` entry, $ref-erenced
// from both routes, not inlined twice.
//
// Finding 16: every place this file asserts `result.valid` from the OpenAPI schema validator also
// asserts on `result.errors` (undefined on the success path — a bare `.toBe(true)` failure reports
// nothing about which meta-schema rule broke).

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Validator } from '@seriousme/openapi-schema-validator';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { registry } from '../index.js';
import { ContractRegistry } from '../_shared/registry.js';
import type { OpenApiDocument } from '../_shared/registry.js';
import { IdempotencyKeyHeader } from '../_shared/headers.js';
import { PROBLEM_STATUS, ProblemSchema } from '../_shared/problem.js';
import { writeOpenApiDocument } from '../scripts/generate-openapi.js';

const OPENAPI_VERSION_PATTERN = /^3\.1\.\d+$/;

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(TESTS_DIR, '..');
const OPENAPI_PATH = resolve(PACKAGE_ROOT, 'openapi', 'openapi.json');

/** A path under a freshly created temp directory that has never existed before this call —
 * finding 15: a test asserting `existsSync` on a path that could already exist from a prior run
 * would pass even if the writer silently no-ops. */
function freshTempOutputPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return join(dir, 'openapi.json');
}

// Types derived from OpenApiDocument itself (not imported separately from zod-openapi's own
// oas31 namespace) so the type guard below is checked against the exact same type as the array
// it filters — no cross-module structural mismatch.
type PathItem = NonNullable<OpenApiDocument['paths']>[string];
type Operation = NonNullable<PathItem['post']>;
type Parameter = NonNullable<Operation['parameters']>[number];
type ParameterObject = Extract<Parameter, { in: string }>;

function isParameterObject(value: Parameter): value is ParameterObject {
  return 'in' in value;
}

describe('Scenario: the OpenAPI document is generated from the Zod contracts', () => {
  // Writes only to a fresh temp path per test — never to the real tracked openapi/openapi.json.
  // Shares no file-system side effect with the drift describe below (finding 7/8): the two
  // describes' execution order does not matter. Do not re-couple them.

  it('writes an OpenAPI document to the given output path (finding 15 — a fresh path that never pre-existed)', () => {
    const outputPath = freshTempOutputPath('pg-eos-contracts-generate-writes-');
    expect(existsSync(outputPath)).toBe(false);

    writeOpenApiDocument(registry, outputPath);

    expect(existsSync(outputPath)).toBe(true);
  });

  it('returns the document it wrote', () => {
    const outputPath = freshTempOutputPath('pg-eos-contracts-generate-returns-');

    const returned = writeOpenApiDocument(registry, outputPath);
    const written = readFileSync(outputPath, 'utf8');

    expect(`${JSON.stringify(returned, null, 2)}\n`).toBe(written);
  });

  it('declares an openapi version of 3.1.x', () => {
    const outputPath = freshTempOutputPath('pg-eos-contracts-generate-version-');
    writeOpenApiDocument(registry, outputPath);

    const document = JSON.parse(readFileSync(outputPath, 'utf8')) as { openapi?: unknown };

    expect(typeof document.openapi).toBe('string');
    expect(document.openapi as string).toMatch(OPENAPI_VERSION_PATTERN);
  });

  it('validates against the official OpenAPI 3.1 schema', async () => {
    const outputPath = freshTempOutputPath('pg-eos-contracts-generate-validates-');
    writeOpenApiDocument(registry, outputPath);

    const document = JSON.parse(readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
    const validator = new Validator();

    const result = await validator.validate(document);

    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it('aborts and writes nothing when the given registry has an invariant violation (finding 1)', () => {
    const outputPath = freshTempOutputPath('pg-eos-contracts-generate-aborts-');
    const violatingRegistry = new ContractRegistry();
    violatingRegistry.registerRoute({
      method: 'POST',
      path: '/fixture/generate/without-idempotency-key',
      summary: 'fixture route missing Idempotency-Key — must abort generation, not write a file',
      responses: { 201: { description: 'Created' } },
    });

    expect(() => writeOpenApiDocument(violatingRegistry, outputPath)).toThrow(
      /POST \/fixture\/generate\/without-idempotency-key/,
    );
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe('Scenario: the committed document never drifts from the contracts', () => {
  // Reads the real tracked openapi/openapi.json straight off disk — no git, no child_process, no
  // write. Never self-heals: it can only fail loudly if the committed file and the registry
  // disagree, in any checkout state (finding 7/8). Shares no file-system side effect with the
  // generation describe above: execution order between the two does not matter.

  it('the committed openapi/openapi.json is byte-identical to a fresh in-memory regeneration from the registry', () => {
    const committed = readFileSync(OPENAPI_PATH, 'utf8');
    const regenerated = `${JSON.stringify(registry.toOpenApiDocument(), null, 2)}\n`;

    expect(regenerated).toBe(committed);
  });
});

describe('ContractRegistry#toOpenApiDocument — full route shape: header/path/query params, body, 2xx and 4xx responses (finding 3)', () => {
  it('emits the fixture route at the right path+method with the right parameter locations, and the document still validates against the OpenAPI 3.1 meta-schema', async () => {
    const fixtureRegistry = new ContractRegistry();
    const path = '/fixture/orders/{orderId}';

    fixtureRegistry.registerRoute({
      method: 'POST',
      path,
      summary: 'Create an order (fixture — exercises every OpenAPI generation branch)',
      request: {
        headers: z.object({ 'idempotency-key': IdempotencyKeyHeader }),
        params: z.object({ orderId: z.string() }),
        query: z.object({ dryRun: z.enum(['true', 'false']) }),
        body: z.object({ note: z.string() }),
      },
      responses: {
        201: { description: 'Created', body: z.object({ id: z.string() }) },
        [PROBLEM_STATUS.CONFLICT]: { description: 'Idempotency-Key reuse', body: ProblemSchema },
      },
    });

    const document = fixtureRegistry.toOpenApiDocument();
    const operation = document.paths?.[path]?.post;

    expect(operation).toBeDefined();

    const parameters = (operation?.parameters ?? []).filter(isParameterObject);
    const locationByName = new Map(parameters.map((parameter) => [parameter.name, parameter.in]));

    expect(locationByName.get('idempotency-key')).toBe('header');
    expect(locationByName.get('orderId')).toBe('path');
    expect(locationByName.get('dryRun')).toBe('query');

    expect(operation?.requestBody).toBeDefined();
    expect(operation?.responses?.['201']).toBeDefined();
    expect(operation?.responses?.[String(PROBLEM_STATUS.CONFLICT)]).toBeDefined();

    const validatable = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
    const validator = new Validator();
    const result = await validator.validate(validatable);

    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
  });
});

describe('ContractRegistry#registerSchema — a registered schema is $ref-erenced, not duplicated, across routes (finding 10)', () => {
  it('emits one components.schemas entry and references it from every route response that reuses it', async () => {
    const fixtureRegistry = new ContractRegistry();
    const registeredProblem = fixtureRegistry.registerSchema('FixtureProblem', ProblemSchema);
    const conflictResponse = {
      description: 'Idempotency-Key reuse',
      body: registeredProblem,
    };

    fixtureRegistry.registerRoute({
      method: 'POST',
      path: '/fixture/schema-reuse/a',
      summary: 'fixture route A reusing the registered Problem schema',
      request: { headers: z.object({ 'idempotency-key': IdempotencyKeyHeader }) },
      responses: { 201: { description: 'Created' }, [PROBLEM_STATUS.CONFLICT]: conflictResponse },
    });

    fixtureRegistry.registerRoute({
      method: 'POST',
      path: '/fixture/schema-reuse/b',
      summary: 'fixture route B reusing the registered Problem schema',
      request: { headers: z.object({ 'idempotency-key': IdempotencyKeyHeader }) },
      responses: { 201: { description: 'Created' }, [PROBLEM_STATUS.CONFLICT]: conflictResponse },
    });

    const document = fixtureRegistry.toOpenApiDocument();

    expect(document.components?.schemas?.FixtureProblem).toBeDefined();

    const refA =
      document.paths?.['/fixture/schema-reuse/a']?.post?.responses?.[
        String(PROBLEM_STATUS.CONFLICT)
      ]?.content?.['application/json']?.schema;
    const refB =
      document.paths?.['/fixture/schema-reuse/b']?.post?.responses?.[
        String(PROBLEM_STATUS.CONFLICT)
      ]?.content?.['application/json']?.schema;

    expect(refA).toEqual({ $ref: '#/components/schemas/FixtureProblem' });
    expect(refB).toEqual(refA);

    const validatable = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
    const validator = new Validator();
    const result = await validator.validate(validatable);

    expect(result.errors).toBeUndefined();
    expect(result.valid).toBe(true);
  });
});
