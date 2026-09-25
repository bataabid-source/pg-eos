// modules/billing/infrastructure/record-billable-event/logger.ts — WBS 4.2 (lane 2).
//
// RESCOPED (Master ruling, round-1 finding 1 — FINAL): 4.2 has no application/ layer, so the
// `Logger` port lives here rather than in a (now-deleted) application/record-billable-event/ports.ts
// — CLAUDE.md · AGENT CONSTRAINTS: "No console.log — pino." A thin adapter over the shared
// @pg-eos/logger package's childLogger. WBS 4.3's system-actor subscribers may inject this (or a
// fixed/spy Logger) when calling ../../infrastructure/record-billable-event/repository.ts's
// `insertBillableEvent`.

import { childLogger } from '@pg-eos/logger';

/** A structured-log field bag — CLAUDE.md · AGENT CONSTRAINTS "No console.log — pino". */
export type LogFields = Record<string, unknown>;

export interface Logger {
  error(obj: LogFields, msg: string): void;
  info(obj: LogFields, msg: string): void;
}

const child = childLogger({ module: 'billing', useCase: 'record-billable-event' });

export const recordBillableEventPinoLogger: Logger = {
  error(obj, msg) {
    child.error(obj, msg);
  },
  info(obj, msg) {
    child.info(obj, msg);
  },
};
