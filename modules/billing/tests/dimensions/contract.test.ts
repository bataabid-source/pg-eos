// modules/billing/tests/dimensions/contract.test.ts — WBS 4.1b PART 1 (lane 2).
//
// Round-1 slice-close review finding 1: `DimensionTypeInputSchema`
// (packages/contracts/billing/dimensions.ts) had no contract test. Pure schema tests — no DB, no
// I/O. Precedent: modules/billing/tests/chart-of-accounts/contract.test.ts (same shape, same
// module, WBS 4.1a).
//
// `DimensionTypeInputSchema` is a plain `z.object({...})` (default zod "strip" mode, not
// `.strict()`), so an unrecognized key is STRIPPED from the parsed output, not rejected outright —
// this file tests that actual behaviour rather than asserting a stricter contract the schema does
// not implement.
//
// Scope note: the contract schema does NOT itself enforce the kind/source_table pairing rule (that
// is the DB CHECK constraint's job — chk_dimension_types_kind_source_table, migration
// 0030_2_dimensions.sql — and the domain function's job — isValidDimensionTypeKindSourcePair /
// assertValidDimensionTypeKindSourcePair, modules/billing/domain/dimensions/invariants.ts, see
// ./invariants.property.test.ts and ./invariants.unit.test.ts). This file only tests what
// `DimensionTypeInputSchema` itself actually validates: field types/shapes, not cross-field
// business rules.

import { describe, expect, it } from 'vitest';

import { DimensionTypeInputSchema } from '@pg-eos/contracts/billing/dimensions';

const VALID_UUID = '00000000-0000-4000-8000-0000000412c1';
const VALID_CODE = 'cost_center';
const VALID_NAME_AR = 'مركز التكلفة — اختبار العقد WBS 4.1b';

const minimalValidInput = {
  entityId: VALID_UUID,
  code: VALID_CODE,
  nameAr: VALID_NAME_AR,
  kind: 'list',
};

const fullValidInput = {
  ...minimalValidInput,
  nameEn: 'Cost centre — contract test',
  isActive: false,
  kind: 'reference' as const,
  sourceTable: 'sales.accounts',
};

describe('DimensionTypeInputSchema — valid input', () => {
  it('parses the minimal required fields (entityId, code, nameAr, kind) successfully', () => {
    const result = DimensionTypeInputSchema.safeParse(minimalValidInput);
    expect(result.success).toBe(true);
  });

  it('parses the full input including optional nameEn/isActive/sourceTable successfully', () => {
    const result = DimensionTypeInputSchema.safeParse(fullValidInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject(fullValidInput);
    }
  });

  it('defaults isActive to true when omitted', () => {
    const result = DimensionTypeInputSchema.parse(minimalValidInput);
    expect(result.isActive).toBe(true);
  });

  it('accepts a sourceTable of null (kind = list, matching the DB\'s nullable column)', () => {
    const result = DimensionTypeInputSchema.safeParse({ ...minimalValidInput, sourceTable: null });
    expect(result.success).toBe(true);
  });

  it('accepts exactly the columns of billing.dimension_types the schema covers (entityId, code, nameAr, nameEn, isActive, kind, sourceTable) and no others', () => {
    const parsed = DimensionTypeInputSchema.parse(fullValidInput);
    expect(Object.keys(parsed).sort()).toEqual(
      ['code', 'entityId', 'isActive', 'kind', 'nameAr', 'nameEn', 'sourceTable'].sort(),
    );
  });
});

describe('DimensionTypeInputSchema — invalid input is rejected', () => {
  it.each([
    ['entityId', 'not-a-uuid'],
    ['code', ''],
    ['nameAr', ''],
    ['kind', 'not_a_real_kind'],
    ['isActive', 'yes'], // wrong type — not a boolean
    ['sourceTable', 123], // wrong type — not a string (nor null)
  ])('rejects an invalid %s value (%s)', (field, badValue) => {
    const input = { ...minimalValidInput, [field]: badValue };
    const result = DimensionTypeInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it.each(['entityId', 'code', 'nameAr', 'kind'])('rejects a missing required field %s', (field) => {
    const input = { ...minimalValidInput } as Record<string, unknown>;
    delete input[field];
    const result = DimensionTypeInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  // The schema itself does NOT enforce the kind/source_table pairing rule (DB CHECK's and the
  // domain function's job, not the contract's) — a schema-valid-but-business-invalid combination
  // (e.g. kind = 'list' with a non-null sourceTable) parses successfully at the contract layer.
  it('parses a kind/sourceTable combination that violates the DB business rule (schema does not enforce cross-field pairing)', () => {
    const result = DimensionTypeInputSchema.safeParse({
      ...minimalValidInput,
      kind: 'list',
      sourceTable: 'sales.accounts',
    });
    expect(result.success).toBe(true);
  });
});

describe('DimensionTypeInputSchema — unrecognized field is stripped, not passed through as a real column', () => {
  it('strips a field that is not a billing.dimension_types column rather than accepting it as one', () => {
    const input = { ...minimalValidInput, notARealColumn: 'x' };
    const result = DimensionTypeInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('notARealColumn');
    }
  });
});
