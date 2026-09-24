// WBS 0.19 — app-local contract for the Decision Inbox (Master decision 2 + 12 of the brief).
// Mirrors `platform.decisions` (database/schema/13B-Schema-Reference-Consolidation.sql:439-457)
// 1:1, nothing more. App-local (not packages/contracts/platform) because `platform` is lane 2's
// lock for this task (tasks/LANE_LOCKS.md) — promote alongside the future real endpoint.
import { z } from 'zod';

export const DecisionItemSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    titleAr: z.string(),
    // "الوقائع المحسوبة — لا نص حر" (computed facts only, never free text) — jsonb, so the value
    // shape itself is unconstrained (booleans/nested objects included), per Master decision 2.
    context: z.record(z.string(), z.unknown()),
    // numeric(14,3), nullable — kept as a string (never a float) per CLAUDE.md AGENT CONSTRAINTS.
    financialImpact: z.string().nullable(),
    // No CHECK constraint on this column in the DDL: 'urgent'/'high' get a presentational accent,
    // anything else (including unknown future values) is a neutral fallback — not a business rule.
    urgency: z.string().default('normal'),
    assignedRole: z.string(),
    // The real DB CHECK (13B:2404-2406).
    status: z.enum(['open', 'decided', 'expired', 'cancelled', 'auto_resolved']),
    dueAt: z.string().datetime().nullable(),
  })
  .meta({ id: 'DecisionItem' });

export type DecisionItem = z.infer<typeof DecisionItemSchema>;

export const DecisionListSchema = z.array(DecisionItemSchema);
