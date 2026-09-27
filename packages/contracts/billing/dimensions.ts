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

import { IdempotencyKeyHeader } from '../_shared/headers.js';
import type { RouteDefinitionInput } from '../_shared/registry.js';
import { OK_RESPONSE, writeErrorResponses } from '../_shared/route-responses.js';

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

// --- WBS 4.1b PART 2 — contract-first wave 1 (Master, ADR-0005 §3) -----------------------------
// SCR-ACC-01 #9 / D-190 hybrid design: list-kind values live in `billing.dimension_values`
// (entity_id, dimension_type_id, code, name, is_active, version); a journal line's dimension is
// `billing.line_dimensions (dimension_type_id, value_id)`. `value_ref` is dropped (D-190) — no
// free-text field exists here. The migration is not written yet; every field below is one of the
// columns D-190 names, nothing else.

// dimension_values.version — every mutable aggregate starts at 1 (same convention as
// platform.sites / sales.accounts).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);

export const DimensionValueInputSchema = z
  .object({
    entityId: UUID_ID,
    dimensionTypeId: UUID_ID,
    code: NON_EMPTY_TEXT,
    name: NON_EMPTY_TEXT,
    isActive: z.boolean().optional().default(true),
  })
  .meta({ id: 'DimensionValueInput' });

export type DimensionValueInput = z.infer<typeof DimensionValueInputSchema>;

// `valueId` is a uuid for both kinds: a dimension_values row (list kind, composite FK) or a row of
// the whitelisted source table (reference kind, billing.assert_dimension_value()).
export const LineDimensionInputSchema = z
  .object({
    dimensionTypeId: UUID_ID,
    valueId: UUID_ID,
  })
  .meta({ id: 'LineDimensionInput' });

export type LineDimensionInput = z.infer<typeof LineDimensionInputSchema>;

// A value is created active; Deactivate is the only is_active edge (D-190), so the create body
// carries no isActive.
export const CreateDimensionValueInputSchema = DimensionValueInputSchema.omit({ isActive: true })
  .extend({ correlationId: UUID_ID })
  .meta({ id: 'CreateDimensionValueInput' });

export type CreateDimensionValueInput = z.infer<typeof CreateDimensionValueInputSchema>;

export const DeactivateDimensionValueInputSchema = z
  .object({
    dimensionValueId: UUID_ID,
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'DeactivateDimensionValueInput' });

export type DeactivateDimensionValueInput = z.infer<typeof DeactivateDimensionValueInputSchema>;

// --- OpenAPI route registrations (contract-first, ADR-0005 §3) ----------------------------------
// No result schema is defined by the brief — every 200 carries no body.
const WRITE_HEADERS = z.object({ 'Idempotency-Key': IdempotencyKeyHeader });

export const ROUTES: readonly RouteDefinitionInput[] = [
  {
    method: 'POST',
    path: '/billing/dimensions/create-dimension-value',
    summary: 'Create dimension value',
    request: { headers: WRITE_HEADERS, body: CreateDimensionValueInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses() },
  },
  {
    method: 'POST',
    path: '/billing/dimensions/deactivate-dimension-value',
    summary: 'Deactivate dimension value',
    request: { headers: WRITE_HEADERS, body: DeactivateDimensionValueInputSchema },
    responses: { 200: OK_RESPONSE, ...writeErrorResponses() },
  },
];
