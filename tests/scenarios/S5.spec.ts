// tests/scenarios/S5.spec.ts — doc 40 Part E, Feature S5 (lines 479-484), integration lane 3 wave 1
// (scratchpad/_slice-X-s5.brief.md).
//
// HONEST STATE: every Gherkin line below is its own `test.step`, verbatim. No cc HTTP/API route
// exists (`modules/cc` is not built — doc-38 row 5.1 "M06 Call center: queues, agents, calls,
// tickets, SLA, ticket ↔ shipment link", acceptance "Agent cannot see another queue's tickets
// (RLS)"; doc 40 line 482 is this scenario's own "When"): the "When" step reports that gap by name
// via a NAMED `expect.soft` — the test still fails, the gap is never hidden or softened into a
// pass. In the SAME step it then performs the request at the only built layer this repo has:
// `withContext(ctx, tx => …)` from '@pg-eos/db' (real pgeos_app role — RLS is genuinely enforced,
// never bypassed), reading both queues' tickets directly against `cc.tickets`. The final "Then"
// (zero SHOP rows) is asserted HARD, not soft — CLAUDE.md/the brief: this may genuinely PASS while
// the API layer stays NOT BUILT, and a genuine DB-level pass is reported as exactly that.
//
// `tx.execute(string)` not `tx.execute(sql\`…\`)`: see fixtures/cc.ts's header comment — drizzle-orm's
// `sql` tag is not a resolvable import from tests/scenarios (not a declared dependency; only
// `@pg-eos/db` itself was added to clear this slice's own STOP condition, package.json/pnpm-lock.yaml
// otherwise untouched). Every interpolated value is a `randomUUID()` this spec generated itself,
// validated as UUID-shaped before interpolation (`uuidLiteral`) — never external input.
//
// DEFAULTS taken (recorded, never asked): `ctx.isInternal: true` — CC_AGENT is an internal role
// (doc 40 line 114), apps/api builds `isInternal: true` for internal subjects, and `cc.tickets`'
// policies never read `is_internal` (`entity_scope` permissive + `agent_queue_scope` restrictive,
// SECURITY DEFINER helpers) — recorded as the lane default. `ctx.entityId`: the queues' own entity
// (SCENARIO_ENTITY_CODE 'PST', same entity used by
// every other scenario fixture) — `platform.allowed_entities()` narrows to it; `createActor` grants
// the actor membership on every entity, a superset, so this is never the blocking factor. Agent role
// code: `CC_AGENT` (identity.roles) — the semantically matching role; RLS itself never reads it
// (only `cc.agents`/`cc.agent_queues` rows do, via `cc.is_agent()`/`cc.current_agent_queues()`).

import { expect, test } from '@playwright/test';
import type { Pool } from 'pg';

import { withContext } from '@pg-eos/db';

import { createActor, teardownActor } from './fixtures/actors.js';
import { runCleanupSteps } from './fixtures/cleanup.js';
import {
  countAgentQueuesForAgent,
  countTicketsForQueue,
  deleteAgent,
  deleteAgentQueuesForAgent,
  deleteQueue,
  deleteTicketsForQueue,
  insertAgent,
  insertAgentQueue,
  insertQueue,
  insertTicket,
  selectTicketIdsSql,
} from './fixtures/cc.js';
import { getEntityIdByCode, SCENARIO_ENTITY_CODE } from './fixtures/lookups.js';
import { createPool } from './fixtures/pool.js';
import { deleteClient, insertClient } from './fixtures/seed.js';

// --- named constants (CLAUDE.md — no magic numbers) -----------------------------------------------

const S5_CLIENT_CODE_PREFIX = '_s5_client_';
const S5_CLIENT_NAME_EN = 'S5 External Call-Center Client';
const S5_CLIENT_NAME_AR = 'عميل اختبار مركز الاتصال S5';
const QUEUE_CODE_PREFIX_CLINIC = '_s5_clinic_';
const QUEUE_CODE_PREFIX_SHOP = '_s5_shop_';
const QUEUE_NAME_AR_CLINIC = 'طابور العيادة (اختبار S5)';
const QUEUE_NAME_AR_SHOP = 'طابور المتجر (اختبار S5)';
const TICKET_CATEGORY = '_s5_test_category';
const TICKET_SUBJECT_CLINIC = '_s5 clinic ticket';
const TICKET_SUBJECT_SHOP = '_s5 shop ticket';
const TICKET_COUNT_PER_QUEUE = 1; // "≥ 1 ticket in EACH queue" (brief) — seeded exactly 1 each.
const SINGLE_AGENT_QUEUE_ASSIGNMENT = 1; // "assigned ONLY to queue CLINIC" — exactly one agent_queues row.
const EXPECTED_ZERO_TICKETS = 0; // doc 40 line 484: "Then zero tickets are returned".
const S5_ACTOR_ROLE_CODES = ['CC_AGENT'] as const;
const A1_ACTOR_NAME_PREFIX = '_s5_a1';
const DOC38_ROW_CC_MODULE = '5.1'; // docs/package/38-WBS.md — "M06 Call center …" row, grep-confirmed.
const NOT_BUILT_CC_API_MESSAGE =
  `NOT BUILT: no cc HTTP/API route exists for "agent requests tickets of a queue" — modules/cc does ` +
  `not exist (doc-38 row ${DOC38_ROW_CC_MODULE} "M06 Call center: queues, agents, calls, tickets, SLA, ` +
  'ticket ↔ shipment link", acceptance "Agent cannot see another queue\'s tickets (RLS)"; doc 40 line 482)';

interface TicketIdRow extends Record<string, unknown> {
  readonly id: string;
}

test.describe('S5 External call-center client', () => {
  const pool: Pool = createPool();

  let entityId: string;
  let clientId: string;
  let clinicQueueId: string;
  let shopQueueId: string;
  let clinicTicketId: string;
  let shopTicketId: string;
  let a1UserId: string;
  let a1AgentId: string;

  // assigned inside the "When" step — read by the "Then" step (describe-level, per the brief).
  let shopReadRows: readonly TicketIdRow[] = [];

  test.beforeAll(async () => {
    entityId = await getEntityIdByCode(pool, SCENARIO_ENTITY_CODE);
  });

  test.afterAll(async () => {
    try {
      await runCleanupSteps([
        ['cc.tickets (CLINIC)', () => (clinicQueueId ? deleteTicketsForQueue(pool, clinicQueueId) : Promise.resolve())],
        ['cc.tickets (SHOP)', () => (shopQueueId ? deleteTicketsForQueue(pool, shopQueueId) : Promise.resolve())],
        ['cc.agent_queues', () => (a1AgentId ? deleteAgentQueuesForAgent(pool, a1AgentId) : Promise.resolve())],
        ['cc.agents', () => (a1AgentId ? deleteAgent(pool, a1AgentId) : Promise.resolve())],
        ['cc.queues (CLINIC)', () => (clinicQueueId ? deleteQueue(pool, clinicQueueId) : Promise.resolve())],
        ['cc.queues (SHOP)', () => (shopQueueId ? deleteQueue(pool, shopQueueId) : Promise.resolve())],
        ['sales.accounts', () => (clientId ? deleteClient(pool, clientId) : Promise.resolve())],
        ['actor', () => (a1UserId ? teardownActor(pool, a1UserId) : Promise.resolve())],
      ]);
    } finally {
      await pool.end();
    }
  });

  test('Queue isolation', async () => {
    await test.step('Given agent "A1" is assigned only to queue "CLINIC"', async () => {
      // doc 40 §C5 line 303: queues carry a client_id or is_internal — S5 is "External call-center
      // client", so both queues below belong to this one seeded external client (review round 1
      // finding 1).
      clientId = await insertClient(pool, { codePrefix: S5_CLIENT_CODE_PREFIX, nameEn: S5_CLIENT_NAME_EN, nameAr: S5_CLIENT_NAME_AR });

      clinicQueueId = await insertQueue(pool, {
        entityId,
        clientId,
        codePrefix: QUEUE_CODE_PREFIX_CLINIC,
        nameAr: QUEUE_NAME_AR_CLINIC,
      });
      shopQueueId = await insertQueue(pool, {
        entityId,
        clientId,
        codePrefix: QUEUE_CODE_PREFIX_SHOP,
        nameAr: QUEUE_NAME_AR_SHOP,
      });

      clinicTicketId = await insertTicket(pool, {
        entityId,
        queueId: clinicQueueId,
        clientId,
        category: TICKET_CATEGORY,
        subject: TICKET_SUBJECT_CLINIC,
      });
      shopTicketId = await insertTicket(pool, {
        entityId,
        queueId: shopQueueId,
        clientId,
        category: TICKET_CATEGORY,
        subject: TICKET_SUBJECT_SHOP,
      });
      expect(clinicTicketId).toBeTruthy();
      expect(shopTicketId).toBeTruthy();

      // seed hard, via the admin pool (bypasses RLS) — "SHOP holds ≥ 1 ticket as seen by the admin
      // pool" (brief), so a later zero on SHOP under RLS is meaningful, never an empty-seed false positive.
      const clinicSeedCount = await countTicketsForQueue(pool, clinicQueueId);
      const shopSeedCount = await countTicketsForQueue(pool, shopQueueId);
      expect(clinicSeedCount).toBe(TICKET_COUNT_PER_QUEUE);
      expect(shopSeedCount).toBe(TICKET_COUNT_PER_QUEUE);

      a1UserId = await createActor(pool, { namePrefix: A1_ACTOR_NAME_PREFIX, roleCodes: S5_ACTOR_ROLE_CODES });
      a1AgentId = await insertAgent(pool, a1UserId);
      await insertAgentQueue(pool, a1AgentId, clinicQueueId);

      const agentQueueCount = await countAgentQueuesForAgent(pool, a1AgentId);
      expect(agentQueueCount).toBe(SINGLE_AGENT_QUEUE_ASSIGNMENT); // "assigned ONLY to queue CLINIC"
    });

    await test.step('When agent "A1" requests tickets of queue "SHOP"', async () => {
      // The API layer is NOT BUILT — reported by name, the test still fails on this line.
      expect.soft(false, NOT_BUILT_CC_API_MESSAGE).toBe(true);

      // The only built layer this repo has: a real RLS-scoped read via withContext (pgeos_app,
      // never a superuser) — kept in a describe-level variable per the brief.
      const ctx = { userId: a1UserId, clientId: null, isInternal: true, entityId };

      const clinicReadResult = await withContext(ctx, (tx) => tx.execute<TicketIdRow>(selectTicketIdsSql(clinicQueueId)));
      const clinicReadRows = clinicReadResult.rows as readonly TicketIdRow[];
      // positive control, asserted HARD: the agent MUST see its own (CLINIC) queue's ticket —
      // otherwise a later zero on SHOP would prove nothing (brief).
      expect(clinicReadRows.map((row) => row.id)).toContain(clinicTicketId);

      const shopReadResult = await withContext(ctx, (tx) => tx.execute<TicketIdRow>(selectTicketIdsSql(shopQueueId)));
      shopReadRows = shopReadResult.rows as readonly TicketIdRow[];
    });

    await test.step('Then zero tickets are returned', async () => {
      // Genuine DB-level pass (cc.tickets' `agent_queue_scope` RESTRICTIVE RLS policy) while the
      // API layer above stays NOT BUILT — asserted HARD, not soft (brief).
      expect(shopReadRows.length).toBe(EXPECTED_ZERO_TICKETS);
    });
  });
});
