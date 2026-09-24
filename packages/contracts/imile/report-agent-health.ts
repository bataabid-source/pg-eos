// packages/contracts/imile/report-agent-health.ts — WBS 3.14.
//
// Zod input schema for the report-agent-health use case's ONE command, ReportAgentHealth. Source:
// docs/package/40-Build-Specification-EN.md §C8 M11 (station agent: dedicated account, single
// session, health heartbeat) and database/schema/01-Data-Model.sql:1426-1436
// (imile.agent_health — append-only, no version column: `id, reported_at default now(), agent_id
// text, session_valid boolean not null, last_pull_at timestamptz, pending_pushes int default 0,
// engine_version text, error_message text`).
//
// There is no `expectedVersion` here (unlike the golden slice's receive-inbound contract) — this
// table is an append-only heartbeat log, not a mutable aggregate with a version column (brief,
// Read ONLY list item 5).
//
// The `.refine` below mirrors, at the contract boundary, the domain rule
// modules/imile/domain/report-agent-health/invariants.ts's assertSessionValidHasReason enforces
// again inside the command — the same "belt and braces" pattern as the golden slice's
// variancePhotoUrl/variancePhotoSha256 pair (packages/contracts/wms/receive-inbound.ts).
//
// TEMPLATE GUIDANCE: one contract file per use case, one exported `<Command>InputSchema` per
// command — scripts/new-slice.sh's sed-rename relies on that literal naming.

import { z } from 'zod';

const UUID_ID = z.string().uuid();
const NON_EMPTY_STRING = z.string().min(1);
// imile.agent_health.pending_pushes: `int default 0` — never negative (a queue depth). The upper
// bound below is the Postgres `int` (int4) column's own range
// (database/schema/01-Data-Model.sql:1426-1436, imile.agent_health.pending_pushes is a plain
// "int" column) — not an invented operational ceiling. This bound exists so an out-of-range value
// is a 400 at the contract boundary instead of a 500 from Postgres (reviewer finding 3, round 2,
// 2026-09-24).
const PENDING_PUSHES_MAX = 2_147_483_647; // int4 max
const NON_NEGATIVE_INT = z.number().int().min(0).max(PENDING_PUSHES_MAX);

export const ReportAgentHealthInputSchema = z
  .object({
    agentId: NON_EMPTY_STRING,
    sessionValid: z.boolean(),
    lastPullAt: z.iso.datetime().nullable().optional(),
    pendingPushes: NON_NEGATIVE_INT,
    engineVersion: NON_EMPTY_STRING,
    errorMessage: z.string().min(1).optional(),
    correlationId: UUID_ID,
  })
  .refine((value) => value.sessionValid === true || value.errorMessage !== undefined, {
    message: 'errorMessage is required when sessionValid is false',
    path: ['errorMessage'],
  })
  .meta({ id: 'ReportAgentHealthInput' });

export type ReportAgentHealthInput = z.infer<typeof ReportAgentHealthInputSchema>;
