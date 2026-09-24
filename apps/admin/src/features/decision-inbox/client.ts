// WBS 0.19 — DecisionsClient port (Master decision 3). One function, swappable for a real HTTP
// client once a `list-decisions` read query exists under modules/platform (future slice, after
// the platform lock frees — no NestJS app exists anywhere in the workspace today).
import type { DecisionItem } from './contract';

export interface DecisionsClient {
  listOpenDecisions(role: string): Promise<DecisionItem[]>;
}
