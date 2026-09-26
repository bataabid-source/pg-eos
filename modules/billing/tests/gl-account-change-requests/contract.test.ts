// modules/billing/tests/gl-account-change-requests/contract.test.ts — WBS 4.1a part 2.
//
// Fix round finding 12: `SubmitGlAccountChangeRequestInputSchema`
// (packages/contracts/billing/gl-account-change-requests.ts) had no contract test. Pure schema
// tests — no DB, no I/O. Precedent: modules/billing/tests/chart-of-accounts/contract.test.ts and
// modules/billing/tests/dimensions/contract.test.ts (same shape, same module).
//
// `SubmitGlAccountChangeRequestInputSchema` is a plain `z.object({...})` (default zod "strip"
// mode, not `.strict()`), so an unrecognized key is STRIPPED from the parsed output, not rejected
// outright — this file tests that actual behaviour. It also carries TWO `.refine()`s (the pairing
// rule and the create-completeness rule) this file exercises explicitly, both the accept and the
// reject side of each.

import { describe, expect, it } from 'vitest';

import { SubmitGlAccountChangeRequestInputSchema } from '@pg-eos/contracts/billing/gl-account-change-requests';

const VALID_ENTITY_UUID = '00000000-0000-4000-8000-0000004a4a01';
const VALID_TARGET_UUID = '00000000-0000-4000-8000-0000004a4a02';
const VALID_PARENT_UUID = '00000000-0000-4000-8000-0000004a4a03';
const VALID_CODE = '1-01-001-001';
const VALID_NAME_AR = 'اسم مقترح — اختبار العقد WBS 4.1a part 2';

const minimalValidCreateInput = {
  entityId: VALID_ENTITY_UUID,
  changeKind: 'create' as const,
  proposedCode: VALID_CODE,
  proposedNameAr: VALID_NAME_AR,
  proposedAccountType: 'asset' as const,
};

const fullValidCreateInput = {
  ...minimalValidCreateInput,
  proposedNameEn: 'Contract test proposed name',
  proposedParentId: VALID_PARENT_UUID,
  proposedIsPostable: false,
};

const minimalValidUpdateInput = {
  entityId: VALID_ENTITY_UUID,
  changeKind: 'update' as const,
  targetAccountId: VALID_TARGET_UUID,
};

describe('SubmitGlAccountChangeRequestInputSchema — valid input', () => {
  it('parses a minimal, complete create request successfully', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(minimalValidCreateInput);
    expect(result.success).toBe(true);
  });

  it('parses the full create request including optional proposedNameEn/proposedParentId/proposedIsPostable successfully', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(fullValidCreateInput);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject(fullValidCreateInput);
    }
  });

  it('parses a minimal update request (targetAccountId set, no proposed_* required) successfully', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(minimalValidUpdateInput);
    expect(result.success).toBe(true);
  });

  it('accepts exactly the columns of billing.gl_account_change_requests the schema covers and no others', () => {
    const parsed = SubmitGlAccountChangeRequestInputSchema.parse(fullValidCreateInput);
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'entityId',
        'changeKind',
        'proposedCode',
        'proposedNameAr',
        'proposedAccountType',
        'proposedNameEn',
        'proposedParentId',
        'proposedIsPostable',
      ].sort(),
    );
  });
});

describe('SubmitGlAccountChangeRequestInputSchema — invalid input is rejected', () => {
  it.each([
    ['entityId', 'not-a-uuid'],
    ['proposedCode', 'off-format-code'],
    ['proposedCode', '0-01-001-001'], // class 0, outside 1-9
    ['proposedNameAr', ''],
    ['proposedAccountType', 'not_a_real_account_type'],
    ['proposedParentId', 'not-a-uuid'],
    ['proposedIsPostable', 'yes'], // wrong type — not a boolean
    // Fix round finding 5: 'deactivate' is now a LEGAL changeKind enum value (WBS 4.1a part 3), so a
    // row using it would only still fail via the unrelated pairing/completeness refines below (missing
    // targetAccountId / stray proposedCode), not via the enum itself — it no longer tests what its own
    // label claims. 'delete' is not, and never has been, a legal changeKind value (mirrors the raw-SQL
    // "change_kind='delete'" still-illegal case in gl-account-change-requests.test.ts), so this row is
    // genuine enum-rejection coverage again.
    ['changeKind', 'delete'],
  ])('rejects an invalid %s value (%s)', (field, badValue) => {
    const input = { ...minimalValidCreateInput, [field]: badValue };
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it.each(['entityId', 'changeKind'])('rejects a missing required field %s', (field) => {
    const input = { ...minimalValidCreateInput } as Record<string, unknown>;
    delete input[field];
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe('SubmitGlAccountChangeRequestInputSchema — unrecognized field is stripped, not passed through as a real column', () => {
  it('strips a field that is not a billing.gl_account_change_requests column rather than accepting it as one', () => {
    const input = { ...minimalValidCreateInput, notARealColumn: 'x' };
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('notARealColumn');
    }
  });
});

describe('SubmitGlAccountChangeRequestInputSchema — pairing refine: create requires a null/absent targetAccountId, update requires a non-null one', () => {
  it('rejects changeKind=create WITH a non-null targetAccountId', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
      ...minimalValidCreateInput,
      targetAccountId: VALID_TARGET_UUID,
    });
    expect(result.success).toBe(false);
  });

  it('accepts changeKind=create with targetAccountId explicitly null', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
      ...minimalValidCreateInput,
      targetAccountId: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects changeKind=update WITHOUT a targetAccountId', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
      entityId: VALID_ENTITY_UUID,
      changeKind: 'update',
    });
    expect(result.success).toBe(false);
  });

  it('rejects changeKind=update WITH targetAccountId explicitly null', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
      entityId: VALID_ENTITY_UUID,
      changeKind: 'update',
      targetAccountId: null,
    });
    expect(result.success).toBe(false);
  });

  it('accepts changeKind=update with a real targetAccountId', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(minimalValidUpdateInput);
    expect(result.success).toBe(true);
  });
});

describe('SubmitGlAccountChangeRequestInputSchema — create-completeness refine: a create request must carry proposedCode/proposedNameAr/proposedAccountType', () => {
  it.each(['proposedCode', 'proposedNameAr', 'proposedAccountType'] as const)(
    'rejects a create request missing %s',
    (field) => {
      const input = { ...minimalValidCreateInput } as Record<string, unknown>;
      delete input[field];
      const result = SubmitGlAccountChangeRequestInputSchema.safeParse(input);
      expect(result.success).toBe(false);
    },
  );

  it('accepts a create request carrying all three required proposed_* fields (positive control)', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(minimalValidCreateInput);
    expect(result.success).toBe(true);
  });

  it('an update request is unconstrained by the create-completeness refine (no proposed_* required)', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(minimalValidUpdateInput);
    expect(result.success).toBe(true);
  });
});

describe('SubmitGlAccountChangeRequestInputSchema — round-3 fix 4 refine: an update request must never carry a proposedCode (code is immutable post-creation)', () => {
  it('rejects changeKind=update WITH a proposedCode', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
      ...minimalValidUpdateInput,
      proposedCode: VALID_CODE,
    });
    expect(result.success).toBe(false);
  });

  it('accepts changeKind=update WITHOUT a proposedCode (positive control)', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(minimalValidUpdateInput);
    expect(result.success).toBe(true);
  });

  it('an update request is otherwise unaffected — a create request with a proposedCode still parses (mirrors the domain\'s isProposedCodeOnlyForCreate)', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(minimalValidCreateInput);
    expect(result.success).toBe(true);
  });
});

// --- WBS 4.1a part 3: CHANGE_KIND widens to ['create','update','deactivate','reactivate'] -----------
// (docs/notes/slice-briefs/_slice-4.1a-part3.brief.md §Contract design). The targetAccountId pairing
// refine widens from `changeKind === 'update'` to `changeKind !== 'create'` on the non-null branch,
// and the proposedCode immutability refine widens from `changeKind !== 'update'` to
// `changeKind !== 'create'` — mirroring the domain/DB widening exactly. No new fields — deactivate/
// reactivate need no proposed_* column at all.

describe('SubmitGlAccountChangeRequestInputSchema — WBS 4.1a part 3: deactivate/reactivate change kinds', () => {
  it.each(['deactivate', 'reactivate'] as const)(
    'accepts changeKind=%s with a non-null targetAccountId',
    (changeKind) => {
      const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
        entityId: VALID_ENTITY_UUID,
        changeKind,
        targetAccountId: VALID_TARGET_UUID,
      });
      expect(result.success).toBe(true);
    },
  );

  it.each(['deactivate', 'reactivate'] as const)(
    'rejects changeKind=%s with a null targetAccountId',
    (changeKind) => {
      const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
        entityId: VALID_ENTITY_UUID,
        changeKind,
        targetAccountId: null,
      });
      expect(result.success).toBe(false);
    },
  );

  it.each(['deactivate', 'reactivate'] as const)(
    'rejects changeKind=%s WITHOUT a targetAccountId at all (missing, not just null)',
    (changeKind) => {
      const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
        entityId: VALID_ENTITY_UUID,
        changeKind,
      });
      expect(result.success).toBe(false);
    },
  );

  it.each(['deactivate', 'reactivate'] as const)(
    'rejects changeKind=%s WITH a proposedCode (deactivate/reactivate must never carry one, same rule as update)',
    (changeKind) => {
      const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
        entityId: VALID_ENTITY_UUID,
        changeKind,
        targetAccountId: VALID_TARGET_UUID,
        proposedCode: VALID_CODE,
      });
      expect(result.success).toBe(false);
    },
  );

  it.each(['deactivate', 'reactivate'] as const)(
    'accepts changeKind=%s WITHOUT a proposedCode (positive control)',
    (changeKind) => {
      const result = SubmitGlAccountChangeRequestInputSchema.safeParse({
        entityId: VALID_ENTITY_UUID,
        changeKind,
        targetAccountId: VALID_TARGET_UUID,
      });
      expect(result.success).toBe(true);
    },
  );

  it('a create request (targetAccountId null/absent) is unaffected by the widened refines — still parses (positive control, no regression)', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(minimalValidCreateInput);
    expect(result.success).toBe(true);
  });

  it('an update request (targetAccountId set, no proposedCode) is unaffected by the widened refines — still parses (positive control, no regression)', () => {
    const result = SubmitGlAccountChangeRequestInputSchema.safeParse(minimalValidUpdateInput);
    expect(result.success).toBe(true);
  });
});
