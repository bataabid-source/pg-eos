// modules/platform/application/maintain-site/update-site.ts — WBS 5.5a part 1 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set). Lock order,
// same discipline as the hr/register-employee precedent
// (../../../hr/application/register-employee/change-employee-status.ts): (1) the site-row lock +
// expectedVersion check (brief D8 — a site outside the caller's entity is invisible to the
// `for update` select, RLS hiding it exactly like a missing id, so SiteNotFoundError fires here;
// the locked row also carries its CURRENT kind/accountId), (2) the role gate (brief D3: HR_MGR,
// OPS_DIR, or GM), (3) the domain invariants (isValidKind / requiresAccount / isValidRadius —
// brief D4, D5) checked against the EFFECTIVE post-update kind/accountId — `input.kind ??
// site.kind` / `input.accountId ?? site.accountId` — never just the fields this call happened to
// supply (brief Facts: the domain re-validates the SAME rules, not new ones), (4) the
// unconditional version bump (brief D7 — every UpdateSite call that passes validation is treated
// as a real change, no no-op detection), (5) the 'platform.site.updated' outbox event, (6) the
// audit row (last, ADR-0002).

import { withIdempotentContext, type IdempotencyInput, type WithContextCtx } from '@pg-eos/db';
import { writeOutboxEvent, type CatalogedEventType } from '@pg-eos/events';

import {
  requiresAccount,
  isValidRadius,
  isValidKind,
  VALID_SITE_KINDS_LIST,
} from '../../domain/maintain-site/invariants.js';
import {
  MissingActorError,
  RoleRequiredError,
  SiteKindInvalidError,
  SiteRadiusInvalidError,
  StaleVersionError,
} from '../../domain/maintain-site/errors.js';
import type { MaintainSiteDeps } from './ports.js';

const AUDIT_OPERATION_UPDATE = 'update';
// Event name listed in packages/events/catalog.ts (Master, MIGRATION-REQUEST-2, 2026-09-24).
const SITE_UPDATED_EVENT_TYPE: CatalogedEventType = 'platform.site.updated';
// brief D3: UpdateSite -> HR_MGR, OPS_DIR, or GM (same set as CreateSite).
const UPDATE_SITE_ROLES = ['HR_MGR', 'OPS_DIR', 'GM'] as const;

export interface UpdateSiteInput {
  readonly siteId: string;
  readonly kind?: string | undefined;
  readonly accountId?: string | undefined;
  readonly warehouseId?: string | undefined;
  readonly nameAr?: string | undefined;
  readonly nameEn?: string | undefined;
  readonly address?: string | undefined;
  readonly geoLat?: number | undefined;
  readonly geoLng?: number | undefined;
  readonly radiusM?: number | undefined;
  readonly contactPhone?: string | undefined;
  readonly isActive?: boolean | undefined;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface UpdateSiteResult {
  readonly id: string;
  readonly version: number;
  // optional (not `boolean | undefined`) — withIdempotentContext's JsonCompatible<T> bound
  // (packages/db/src/idempotency.ts) rejects a required property typed to include `undefined`,
  // since `undefined` is not a JsonPrimitive; the replay path's own JSON round-trip already drops
  // an absent key the same way an optional property would.
  readonly isActive?: boolean;
}

export async function updateSite(
  ctx: WithContextCtx,
  input: UpdateSiteInput,
  deps: MaintainSiteDeps,
): Promise<UpdateSiteResult> {
  if (!ctx.userId) throw new MissingActorError('UpdateSite requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<UpdateSiteResult>(ctx, input.idem, async (tx) => {
    const site = await deps.repo.getSiteForUpdate(tx, input.siteId);
    if (site.version !== input.expectedVersion) {
      throw new StaleVersionError(
        `UpdateSite: expectedVersion ${input.expectedVersion} no longer matches site ${input.siteId}'s ` +
          `version ${site.version} (optimistic lock).`,
      );
    }

    if (!(await deps.repo.hasAnyRole(tx, UPDATE_SITE_ROLES))) {
      throw new RoleRequiredError(`UpdateSite requires role ${UPDATE_SITE_ROLES.join(' or ')} (platform.my_roles()).`);
    }

    if (input.kind !== undefined && !isValidKind(input.kind)) {
      throw new SiteKindInvalidError(
        `UpdateSite: kind "${input.kind}" is not one of the values chk_sites_kind allows (brief D4). ` +
          `(Allowed: ${VALID_SITE_KINDS_LIST})`,
      );
    }
    // effective post-update values — the caller's own field when supplied, else whatever the row
    // already holds (brief Facts: the domain re-validates the SAME rules, not new ones).
    requiresAccount(input.kind ?? site.kind, input.accountId ?? site.accountId);
    if (!isValidRadius(input.radiusM)) {
      throw new SiteRadiusInvalidError(
        `UpdateSite: radiusM ${String(input.radiusM)} must be greater than 0 when supplied (brief D5).`,
      );
    }

    const updated = await deps.repo.updateSite(tx, input.siteId, {
      kind: input.kind,
      accountId: input.accountId,
      warehouseId: input.warehouseId,
      nameAr: input.nameAr,
      nameEn: input.nameEn,
      address: input.address,
      geoLat: input.geoLat,
      geoLng: input.geoLng,
      radiusM: input.radiusM,
      contactPhone: input.contactPhone,
      isActive: input.isActive,
    });

    await writeOutboxEvent(tx, {
      entityId: site.entityId,
      aggregateType: 'platform.sites',
      aggregateId: input.siteId,
      eventType: SITE_UPDATED_EVENT_TYPE,
      payload: { siteId: input.siteId, version: updated.version },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId: site.entityId,
      recordId: input.siteId,
      operation: AUDIT_OPERATION_UPDATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { version: updated.version, isActive: input.isActive },
      occurredAt: deps.clock.now(),
    });

    // `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional property directly
    // — the key is included only when the caller actually supplied isActive.
    return input.isActive === undefined
      ? { id: input.siteId, version: updated.version }
      : { id: input.siteId, version: updated.version, isActive: input.isActive };
  });
}
