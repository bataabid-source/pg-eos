// packages/contracts/platform/maintain-site.ts — WBS 5.5a part 1 (lane 2).
//
// Zod input schemas for the maintain-site use case's two commands (brief D2: CreateSite,
// UpdateSite — no separate Activate/Deactivate command). `kind` is the 5-value enum
// (chk_sites_kind, migration 0015). `performedBy` does NOT exist on any schema: the actor is
// ALWAYS `ctx.userId`. `entityId` does NOT exist either — brief D6: "entity_id = ctx.entityId
// (never caller-supplied)". `radiusM` is optional and, when supplied, must be a positive number
// (brief D5) — an omitted value lets the DB column default (platform.att_geofence_radius_m())
// fire; this contract never hardcodes 500. UpdateSite carries `expectedVersion` (brief D8,
// optimistic lock) — a stale one -> StaleVersionError (409).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command — scripts/new-slice.sh's sed-rename relies on that literal naming.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
// migration 0015 chk_sites_kind — the five values SCR-HR-SHIFT-01 §2.4 names.
const SITE_KINDS = ['warehouse', 'office', 'client_pickup', 'housing', 'other'] as const;
// platform.sites.version starts at 1 (migration 0015: int not null default 1).
const MIN_VERSION = 1;
const EXPECTED_VERSION = z.number().int().min(MIN_VERSION);

export const CreateSiteInputSchema = z
  .object({
    kind: z.enum(SITE_KINDS),
    accountId: UUID_ID.optional(),
    warehouseId: UUID_ID.optional(),
    nameAr: z.string().min(1),
    nameEn: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    geoLat: z.number().optional(),
    geoLng: z.number().optional(),
    // NO `.positive()` refinement here — brief D5 assigns that check to the domain layer
    // (isValidRadius/SiteRadiusInvalidError, modules/platform/domain/maintain-site/invariants.ts)
    // so a non-positive value maps to 422 SiteRadiusInvalidError, not a generic 400 ZodError
    // (scenario: "A caller-supplied radius must be positive").
    radiusM: z.number().optional(),
    contactPhone: z.string().min(1).optional(),
    correlationId: UUID_ID,
  })
  .meta({ id: 'CreateSiteInput' });

export type CreateSiteInput = z.infer<typeof CreateSiteInputSchema>;

export const UpdateSiteInputSchema = z
  .object({
    siteId: UUID_ID,
    kind: z.enum(SITE_KINDS).optional(),
    accountId: UUID_ID.optional(),
    warehouseId: UUID_ID.optional(),
    nameAr: z.string().min(1).optional(),
    nameEn: z.string().min(1).optional(),
    address: z.string().min(1).optional(),
    geoLat: z.number().optional(),
    geoLng: z.number().optional(),
    // NO `.positive()` refinement here either — see CreateSiteInputSchema's own comment above.
    radiusM: z.number().optional(),
    contactPhone: z.string().min(1).optional(),
    isActive: z.boolean().optional(),
    expectedVersion: EXPECTED_VERSION,
    correlationId: UUID_ID,
  })
  .meta({ id: 'UpdateSiteInput' });

export type UpdateSiteInput = z.infer<typeof UpdateSiteInputSchema>;
