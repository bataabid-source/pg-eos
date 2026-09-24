// modules/platform/application/maintain-site/create-site.ts — WBS 5.5a part 1 (lane 2).
//
// application/ layer, ONE withIdempotentContext transaction (step 0 — see
// ../../../../packages/db/src/idempotency.ts — runs first when input.idem is set). Order,
// modelled on the hr/register-employee precedent
// (../../../hr/application/register-employee/register-employee.ts): (1) the role gate (brief D3:
// HR_MGR, OPS_DIR, or GM), (2) the domain invariants (requiresAccount / isValidRadius — brief D4,
// D5 — thrown BEFORE any DB write, never relying on the DB CHECK's own error), (3) resolve the
// caller's own entity (brief D6 — never caller-supplied), (4) the INSERT (the repository's own
// column list omits `radius_m` entirely when the caller supplied none, so the DB column default
// fires — brief D5), (5) the 'platform.site.created' outbox event, (6) the audit row (last,
// ADR-0002 — no row lock is taken after it; this command takes no row lock at all, since it only
// inserts).

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
} from '../../domain/maintain-site/errors.js';
import type { MaintainSiteDeps } from './ports.js';

const AUDIT_OPERATION_CREATE = 'insert';
// Event name listed in packages/events/catalog.ts (Master, MIGRATION-REQUEST-2, 2026-09-24) —
// typed as CatalogedEventType so a typo fails typecheck, as the golden slice does for its own
// events.
const SITE_CREATED_EVENT_TYPE: CatalogedEventType = 'platform.site.created';
const SITES_AGGREGATE_TYPE = 'platform.sites';
// brief D3: CreateSite -> HR_MGR, OPS_DIR, or GM.
const CREATE_SITE_ROLES = ['HR_MGR', 'OPS_DIR', 'GM'] as const;

export interface CreateSiteInput {
  readonly kind: string;
  readonly accountId?: string | undefined;
  readonly warehouseId?: string | undefined;
  readonly nameAr: string;
  readonly nameEn?: string | undefined;
  readonly address?: string | undefined;
  readonly geoLat?: number | undefined;
  readonly geoLng?: number | undefined;
  readonly radiusM?: number | undefined;
  readonly contactPhone?: string | undefined;
  readonly correlationId: string;
  readonly idem?: IdempotencyInput | undefined;
}

export interface CreateSiteResult {
  readonly id: string;
  readonly version: number;
  readonly radiusM: number;
}

export async function createSite(
  ctx: WithContextCtx,
  input: CreateSiteInput,
  deps: MaintainSiteDeps,
): Promise<CreateSiteResult> {
  if (!ctx.userId) throw new MissingActorError('CreateSite requires ctx.userId.');
  const actorId = ctx.userId;

  return withIdempotentContext<CreateSiteResult>(ctx, input.idem, async (tx) => {
    if (!(await deps.repo.hasAnyRole(tx, CREATE_SITE_ROLES))) {
      throw new RoleRequiredError(`CreateSite requires role ${CREATE_SITE_ROLES.join(' or ')} (platform.my_roles()).`);
    }

    if (!isValidKind(input.kind)) {
      throw new SiteKindInvalidError(
        `CreateSite: kind "${input.kind}" is not one of the values chk_sites_kind allows (brief D4). ` +
          `(Allowed: ${VALID_SITE_KINDS_LIST})`,
      );
    }
    requiresAccount(input.kind, input.accountId ?? null);
    if (!isValidRadius(input.radiusM)) {
      throw new SiteRadiusInvalidError(
        `CreateSite: radiusM ${String(input.radiusM)} must be greater than 0 when supplied (brief D5).`,
      );
    }

    const entityId = await deps.repo.resolveCallerEntityId(tx);

    const inserted = await deps.repo.insertSite(tx, {
      entityId,
      kind: input.kind,
      accountId: input.accountId ?? null,
      warehouseId: input.warehouseId ?? null,
      nameAr: input.nameAr,
      nameEn: input.nameEn ?? null,
      address: input.address ?? null,
      geoLat: input.geoLat ?? null,
      geoLng: input.geoLng ?? null,
      radiusM: input.radiusM,
      contactPhone: input.contactPhone ?? null,
    });

    await writeOutboxEvent(tx, {
      entityId,
      aggregateType: SITES_AGGREGATE_TYPE,
      aggregateId: inserted.id,
      eventType: SITE_CREATED_EVENT_TYPE,
      payload: { siteId: inserted.id, kind: input.kind },
      correlationId: input.correlationId,
      actorId,
    });

    await deps.repo.writeAuditRow(tx, {
      entityId,
      recordId: inserted.id,
      operation: AUDIT_OPERATION_CREATE,
      correlationId: input.correlationId,
      actorId,
      newValue: { kind: input.kind, nameAr: input.nameAr, version: inserted.version },
      occurredAt: deps.clock.now(),
    });

    return { id: inserted.id, version: inserted.version, radiusM: inserted.radiusM };
  });
}
