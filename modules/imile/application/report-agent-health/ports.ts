// modules/imile/application/report-agent-health/ports.ts — WBS 3.14.
//
// application/ layer: the ports this use case programs against. The command takes ONE
// `deps: ReportAgentHealthDeps` (clock, ids, repo, logger) and never imports infrastructure/.
// ../../infrastructure/report-agent-health/repository.ts implements `AgentHealthRepository`;
// ../../api/report-agent-health/composition.ts wires it.
//
// TEMPLATE GUIDANCE: a later slice's own ports.ts declares its OWN interface(s) named after its
// own aggregate — do not import this file from another use case.

import type { Clock, IdGenerator } from '@pg-eos/domain-kit';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

/** The clock and id generator the command needs (injected — domain-kit adapters in production,
 *  fixed ones in tests). */
export interface ClockDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". Any value
 *  is accepted (including an `err` key holding the raw caught `unknown`/Error value) so a caller
 *  can pass pino's own `err` convention straight through without narrowing it first. */
export type LogFields = Record<string, unknown>;

/** A structured logger port. Implemented by ../../infrastructure/report-agent-health/logger.ts (a
 *  @pg-eos/logger child-logger adapter); a fixed no-op/spy implementation in tests. */
export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

/** Everything the command needs, injected by the composition root
 *  (../../api/report-agent-health/composition.ts). The command programs only against these ports
 *  — the application layer never imports infrastructure/. */
export interface ReportAgentHealthDeps extends ClockDeps {
  readonly repo: AgentHealthRepository;
  readonly logger: Logger;
}

/** the newly-inserted imile.agent_health row's own identity, returned to the caller. */
export interface InsertedAgentHealthRow {
  readonly id: string;
  readonly reportedAt: Date;
}

export interface InsertAgentHealthParams {
  readonly agentId: string;
  readonly sessionValid: boolean;
  readonly lastPullAt: Date | null;
  readonly pendingPushes: number;
  readonly engineVersion: string;
  readonly errorMessage: string | null;
  readonly reportedAt: Date;
}

/** Every DB statement the report-agent-health use case needs, as an interface — the port the
 *  application layer programs against. Implemented by
 *  ../../infrastructure/report-agent-health/repository.ts. */
export interface AgentHealthRepository {
  /** append-only INSERT — imile.agent_health has no version column, so there is no UPDATE path
   *  here at all (brief, Read ONLY list item 5). */
  insertAgentHealth(tx: NodePgDatabase, params: InsertAgentHealthParams): Promise<InsertedAgentHealthRow>;
  /** doc 40 P3/P7: one append-only audit_log row. This call writes only this
   *  `platform.audit_log` row and the `imile.agent_health` row — no `platform.outbox` row, for
   *  now: a heartbeat has no `entity_id` and is not a commercial/operational event of one entity,
   *  so it is not published to the outbox (G-01 gap,
   *  docs/notes/2026-09-24-imile-agent-scenario.md §4 row 'e'). `entityId` is always null —
   *  imile.agent_health carries no entity_id column (brief §2). */
  writeAuditRow(
    tx: NodePgDatabase,
    params: {
      readonly recordId: string;
      readonly operation: string;
      readonly correlationId: string;
      readonly actorId: string;
      readonly newValue: unknown;
      readonly occurredAt: Date;
    },
  ): Promise<void>;
}
