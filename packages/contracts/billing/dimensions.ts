// packages/contracts/billing/dimensions.ts — WBS 4.1b PART 1 (lane 2).
//
// Zod contract for the entity-scoped table of SCR-ACC-01 #9 part 1 (ADR-0004 D1 6 / D2 (d)):
// `billing.dimension_types` ONLY. No field here that is not a column of
// `database/migrations/0030_2_dimensions.sql` (reviewed, numbered, applied). `billing.line_dimensions` does not exist yet — its
// `LineDimensionInputSchema` is part 2's, once that table (and the value structure that gives it
// meaning, D-190 hybrid design) is built. This table has no lifecycle (no machine.ts this slice) —
// the schema below describes INSERT-shaped input only; no update/patch shape exists yet.
//
// This slice ships no application command / api handler (brief: "no write path built yet, same
// rescoping precedent as 4.1a part 1") — this contract is for a future write-path command;
// nothing here blocks adding one later.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// billing.dimension_types.code: free-text data (SCR-ACC-01 #9 — "dimensions as data"), never a
// closed enum at the contract layer.
const NON_EMPTY_TEXT = z.string().min(1);

export const DimensionTypeInputSchema = z
  .object({
    entityId: UUID_ID,
    code: NON_EMPTY_TEXT,
    nameAr: NON_EMPTY_TEXT,
    nameEn: z.string().optional(),
    isActive: z.boolean().optional().default(true),
    kind: z.enum(['list', 'reference']),
    sourceTable: z.string().optional().nullable(),
  })
  .meta({ id: 'DimensionTypeInput' });

export type DimensionTypeInput = z.infer<typeof DimensionTypeInputSchema>;
