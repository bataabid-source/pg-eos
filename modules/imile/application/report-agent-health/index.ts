// modules/imile/application/report-agent-health/index.ts — WBS 3.14.
//
// Barrel for the report-agent-health use case's ONE command (application/ layer public surface).

export type { AgentHealthRepository, ClockDeps, InsertAgentHealthParams, InsertedAgentHealthRow, Logger, ReportAgentHealthDeps } from './ports.js';
export { reportAgentHealth, type ReportAgentHealthInput, type ReportAgentHealthResult } from './report-agent-health.js';
