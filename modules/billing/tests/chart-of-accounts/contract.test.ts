// modules/billing/tests/chart-of-accounts/contract.test.ts — WBS 4.1a (lane 2).
//
// Round-1 review finding 7: `GlAccountInputSchema` (packages/contracts/billing/chart-of-accounts.ts)
// had no contract test. Pure schema tests — no DB, no I/O — expected GREEN now (the schema is
// already built and depends on nothing this slice's migration adds).
//
// `GlAccountInputSchema` is a plain `z.object({...})` (default zod "strip" mode, not `.strict()`),
// so an unrecognized key is STRIPPED from the parsed output, not rejected outright — this file
// tests that actual behaviour rather than asserting a stricter contract the schema does not
// implement.

import { describe, expect, it } from 'vitest';

import { GlAccountInputSchema } from '@pg-eos/contracts/billing/chart-of-accounts';

const VALID_UUID = '00000000-0000-4000-8000-0000000410b1';
const VALID_PARENT_UUID = '00000000-0000-4000-8000-0000000410b2';
const VALID_CODE = '7-01-001-001';
const VALID_NAME_AR = 'حساب اختبار العقد — WBS 4.1a';

const minimalValidInput = {
  entityId: VALID_UUID,
  code: VALID_CODE,
  nameAr: VALID_NAME_AR,
  accountType: 'asset',
};

const fullValidInput = {
  ...minimalValidInput,
  nameEn: 'Contract test account',
  parentId: VALID_PARENT_UUID,
  isPostable: false,
};

describe('GlAccountInputSchema — valid input', () => {
  it('parses the minimal required fields (entityId, code, nameAr, accountType) successfully', () => {
    const result = GlAccountInputSchema.safeParse(minimalValidInput);
    expect(result.success).toBe(true);
  });

  it('parses the full input including optional nameEn/parentId/isPostable successfully', () => {
    const result = GlAccountInputSchema.safeParse(fullValidInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject(fullValidInput);
    }
  });

  it('accepts exactly the columns of billing.gl_accounts and no others (entityId, code, nameAr, nameEn, accountType, parentId, isPostable)', () => {
    const parsed = GlAccountInputSchema.parse(fullValidInput);
    expect(Object.keys(parsed).sort()).toEqual(
      ['accountType', 'code', 'entityId', 'isPostable', 'nameAr', 'nameEn', 'parentId'].sort(),
    );
  });
});

describe('GlAccountInputSchema — invalid input is rejected', () => {
  it.each([
    ['entityId', 'not-a-uuid'],
    ['code', 'off-format-code'],
    ['code', '0-01-001-001'], // class 0, outside 1-9
    ['nameAr', ''],
    ['accountType', 'not_a_real_account_type'],
    ['parentId', 'not-a-uuid'],
    ['isPostable', 'yes'], // wrong type — not a boolean
  ])('rejects an invalid %s value (%s)', (field, badValue) => {
    const input = { ...minimalValidInput, [field]: badValue };
    const result = GlAccountInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it.each(['entityId', 'code', 'nameAr', 'accountType'])('rejects a missing required field %s', (field) => {
    const input = { ...minimalValidInput } as Record<string, unknown>;
    delete input[field];
    const result = GlAccountInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('GlAccountInputSchema — unrecognized field is stripped, not passed through as a real column', () => {
  it('strips a field that is not a billing.gl_accounts column rather than accepting it as one', () => {
    const input = { ...minimalValidInput, notARealColumn: 'x' };
    const result = GlAccountInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('notARealColumn');
    }
  });
});
