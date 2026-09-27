// packages/contracts/tests/billing-dimensions-part2.test.ts — WBS 4.1b PART 2 (lane 2),
// contract-first wave 1 (Master, ADR-0005 §3). RED before pg-builder-core's handlers.ts (WBS 4.1b
// part 2) exists — pure Zod schema + registry tests, no DB, no I/O; precedent:
// modules/billing/tests/dimensions/contract.test.ts (part 1's own contract test).
//
// Covers billing/dimensions.ts's part-2 exports: DimensionValueInputSchema,
// LineDimensionInputSchema, CreateDimensionValueInputSchema, DeactivateDimensionValueInputSchema,
// and the 2 registered ROUTES (create/deactivate-dimension-value). Part 1's
// DimensionTypeInputSchema already has its own contract test
// (modules/billing/tests/dimensions/contract.test.ts) — not duplicated here.

import { describe, expect, it } from 'vitest';

import {
  CreateDimensionValueInputSchema,
  DeactivateDimensionValueInputSchema,
  DimensionValueInputSchema,
  LineDimensionInputSchema,
  ROUTES as BILLING_DIMENSIONS_ROUTES,
} from '@pg-eos/contracts/billing/dimensions';
import { registry } from '@pg-eos/contracts';

const VALID_ENTITY_ID = '00000000-0000-4000-8000-00000004b1a1';
const VALID_DIMENSION_TYPE_ID = '00000000-0000-4000-8000-00000004b1a2';
const VALID_VALUE_ID = '00000000-0000-4000-8000-00000004b1a3';
const VALID_CORRELATION_ID = '00000000-0000-4000-8000-00000004b1a4';
const VALID_DIMENSION_VALUE_ID = '00000000-0000-4000-8000-00000004b1a5';

describe('DimensionValueInputSchema — valid input', () => {
  const minimalValidInput = {
    entityId: VALID_ENTITY_ID,
    dimensionTypeId: VALID_DIMENSION_TYPE_ID,
    code: 'riyadh_branch',
    name: 'Riyadh branch',
  };

  it('parses the minimal required fields successfully', () => {
    expect(DimensionValueInputSchema.safeParse(minimalValidInput).success).toBe(true);
  });

  it('defaults isActive to true when omitted', () => {
    const parsed = DimensionValueInputSchema.parse(minimalValidInput);
    expect(parsed.isActive).toBe(true);
  });

  it('accepts exactly the documented column list (entityId, dimensionTypeId, code, name, isActive) and no others', () => {
    const parsed = DimensionValueInputSchema.parse({ ...minimalValidInput, isActive: false });
    expect(Object.keys(parsed).sort()).toEqual(
      ['code', 'dimensionTypeId', 'entityId', 'isActive', 'name'].sort(),
    );
  });
});

describe('DimensionValueInputSchema — invalid input is rejected', () => {
  const minimalValidInput = {
    entityId: VALID_ENTITY_ID,
    dimensionTypeId: VALID_DIMENSION_TYPE_ID,
    code: 'riyadh_branch',
    name: 'Riyadh branch',
  };

  it.each([
    ['entityId', 'not-a-uuid'],
    ['dimensionTypeId', 'not-a-uuid'],
    ['code', ''],
    ['name', ''],
    ['isActive', 'yes'],
  ])('rejects an invalid %s value (%s)', (field, badValue) => {
    const input = { ...minimalValidInput, [field]: badValue };
    expect(DimensionValueInputSchema.safeParse(input).success).toBe(false);
  });

  it.each(['entityId', 'dimensionTypeId', 'code', 'name'])(
    'rejects a missing required field %s',
    (field) => {
      const input = { ...minimalValidInput } as Record<string, unknown>;
      delete input[field];
      expect(DimensionValueInputSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe('LineDimensionInputSchema — valid/invalid input', () => {
  const minimalValidInput = { dimensionTypeId: VALID_DIMENSION_TYPE_ID, valueId: VALID_VALUE_ID };

  it('parses the minimal required fields successfully', () => {
    expect(LineDimensionInputSchema.safeParse(minimalValidInput).success).toBe(true);
  });

  it('accepts exactly dimensionTypeId and valueId and no others', () => {
    const parsed = LineDimensionInputSchema.parse(minimalValidInput);
    expect(Object.keys(parsed).sort()).toEqual(['dimensionTypeId', 'valueId'].sort());
  });

  it.each([
    ['dimensionTypeId', 'not-a-uuid'],
    ['valueId', 'not-a-uuid'],
  ])('rejects an invalid %s value (%s)', (field, badValue) => {
    const input = { ...minimalValidInput, [field]: badValue };
    expect(LineDimensionInputSchema.safeParse(input).success).toBe(false);
  });

  it.each(['dimensionTypeId', 'valueId'])('rejects a missing required field %s', (field) => {
    const input = { ...minimalValidInput } as Record<string, unknown>;
    delete input[field];
    expect(LineDimensionInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('CreateDimensionValueInputSchema — extends DimensionValueInputSchema with correlationId', () => {
  const minimalValidInput = {
    entityId: VALID_ENTITY_ID,
    dimensionTypeId: VALID_DIMENSION_TYPE_ID,
    code: 'riyadh_branch',
    name: 'Riyadh branch',
    correlationId: VALID_CORRELATION_ID,
  };

  it('parses the minimal required fields successfully', () => {
    expect(CreateDimensionValueInputSchema.safeParse(minimalValidInput).success).toBe(true);
  });

  it('accepts exactly the documented column list plus correlationId, without isActive (a value is created active, D-190)', () => {
    const parsed = CreateDimensionValueInputSchema.parse({ ...minimalValidInput, isActive: false });
    expect(Object.keys(parsed).sort()).toEqual(
      ['code', 'correlationId', 'dimensionTypeId', 'entityId', 'name'].sort(),
    );
  });

  it('rejects a non-uuid correlationId', () => {
    expect(
      CreateDimensionValueInputSchema.safeParse({
        ...minimalValidInput,
        correlationId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing correlationId', () => {
    const input = { ...minimalValidInput } as Record<string, unknown>;
    delete input.correlationId;
    expect(CreateDimensionValueInputSchema.safeParse(input).success).toBe(false);
  });
});

describe('DeactivateDimensionValueInputSchema — valid/invalid input', () => {
  const minimalValidInput = {
    dimensionValueId: VALID_DIMENSION_VALUE_ID,
    expectedVersion: 1,
    correlationId: VALID_CORRELATION_ID,
  };

  it('parses the minimal required fields successfully', () => {
    expect(DeactivateDimensionValueInputSchema.safeParse(minimalValidInput).success).toBe(true);
  });

  it('accepts exactly dimensionValueId, expectedVersion, correlationId and no others', () => {
    const parsed = DeactivateDimensionValueInputSchema.parse(minimalValidInput);
    expect(Object.keys(parsed).sort()).toEqual(
      ['correlationId', 'dimensionValueId', 'expectedVersion'].sort(),
    );
  });

  it('rejects expectedVersion = 0 (must be >= 1, MIN_VERSION)', () => {
    expect(
      DeactivateDimensionValueInputSchema.safeParse({ ...minimalValidInput, expectedVersion: 0 })
        .success,
    ).toBe(false);
  });

  it('rejects a non-integer expectedVersion', () => {
    expect(
      DeactivateDimensionValueInputSchema.safeParse({ ...minimalValidInput, expectedVersion: 1.2 })
        .success,
    ).toBe(false);
  });

  it.each(['dimensionValueId', 'expectedVersion', 'correlationId'])(
    'rejects a missing required field %s',
    (field) => {
      const input = { ...minimalValidInput } as Record<string, unknown>;
      delete input[field];
      expect(DeactivateDimensionValueInputSchema.safeParse(input).success).toBe(false);
    },
  );
});

describe('billing/dimensions ROUTES (part 2) — registered on the shared production registry', () => {
  const expectedPaths = [
    '/billing/dimensions/create-dimension-value',
    '/billing/dimensions/deactivate-dimension-value',
  ];

  it('declares exactly 2 POST routes', () => {
    expect(BILLING_DIMENSIONS_ROUTES.length).toBe(2);
    for (const route of BILLING_DIMENSIONS_ROUTES) {
      expect(route.method).toBe('POST');
    }
  });

  it.each(expectedPaths)('registers %s on the shared registry with an Idempotency-Key header', (path) => {
    const document = registry.toOpenApiDocument();
    const pathItem = document.paths?.[path] as Record<string, unknown> | undefined;
    expect(pathItem, `${path} must be registered`).toBeDefined();
    const operation = pathItem?.post as
      | { parameters?: ReadonlyArray<{ name?: string; required?: boolean }> }
      | undefined;
    expect(operation, `${path} must be a POST operation`).toBeDefined();
    const idempotencyHeader = operation?.parameters?.find(
      (parameter) => parameter.name?.toLowerCase() === 'idempotency-key',
    );
    expect(idempotencyHeader, `${path} must declare the Idempotency-Key header`).toBeDefined();
    expect(idempotencyHeader?.required).toBe(true);
  });

  it('every route carries a Problem-bodied 400/409/422 response', () => {
    const document = registry.toOpenApiDocument();
    for (const path of expectedPaths) {
      const pathItem = document.paths?.[path] as
        | { post?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } }
        | undefined;
      const responses = pathItem?.post?.responses ?? {};
      for (const status of ['400', '409', '422']) {
        const schema = responses[status]?.content?.['application/json']?.schema;
        expect(schema, `${path} status ${status}`).toEqual({ $ref: '#/components/schemas/Problem' });
      }
    }
  });

  it('registers zero invariant violations for these routes (registry.checkInvariants())', () => {
    expect(registry.checkInvariants()).toEqual([]);
  });
});
