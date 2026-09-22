// packages/identity/tests/rbac-sod.test.ts — WBS 0.17 (pg-tester), RED phase.
//
// RED, and why it is the right RED: `packages/identity/src/rbac.ts` does not exist yet —
// pg-backend builds it next, to exactly the contract these tests pin down. The import below fails
// to resolve; same class of RED as WBS 0.11 and WBS 0.12 in this repo.
//
// Scope: "Feature: RBAC / SoD evaluation" of the WBS 0.17 slice brief — five Gherkin scenarios and
// the brief's property test over identity.sod_rules.
//
// What this suite does NOT do: it does not re-implement, mirror, or second-guess the SoD rule. The
// rule lives in the database — `identity.check_sod()` + trigger `trg_sod`
// (database/schema/13B-Schema-Reference-Consolidation.sql:538-555), which fires `before insert or
// update of role_id, user_id, revoked_at on identity.user_roles` and raises when the new role and
// an existing, unrevoked role of the same user form an active identity.sod_rules pair in EITHER
// direction. These tests prove that assignRole surfaces that rejection as a typed error rather
// than swallowing, retrying around, or pre-empting it with its own copy of the rule.
//
// Reference data this suite reads but never writes (13B:446-473, 531-536):
//   identity.roles     — the 26 seeded role codes; CFO · ACCOUNTANT · WH_MGR · HR_MGR are used.
//   identity.sod_rules — the seeded conflict pairs; the property test reads them at run time and
//                        never hardcodes their number (EXEC-v4 §1.6 currently defines four; the
//                        table, not this file, is the source of truth).
//
// Fixture data this suite creates and removes: identity.users rows (randomUUID()-suffixed
// .invalid emails), their identity.user_roles / identity.user_entities rows (both `on delete
// cascade` from identity.users, so deleting the user removes them), and ONE probe row in
// identity.permissions plus its identity.role_permissions link, both randomUUID()-suffixed and
// both deleted in afterAll. No seeded role, permission, or SoD rule is modified.

import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import type { QueryResult } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The package under test — does not exist yet. This is the RED.
import {
  hasPermission,
  assignRole,
  listRoles,
  allowedEntities,
  SodViolationError,
} from '../src/rbac.js';

// Role codes from the 13B seed (13B:446-473), quoted by the WBS 0.17 brief's scenarios. Their
// existence is verified against identity.roles in beforeAll rather than assumed.
const ROLE_CFO = 'CFO';
const ROLE_ACCOUNTANT = 'ACCOUNTANT';
const ROLE_WH_MGR = 'WH_MGR';
const ROLE_HR_MGR = 'HR_MGR';

/**
 * PostgreSQL SQLSTATE 23503 — foreign_key_violation (PostgreSQL docs, Appendix A, Class 23). What
 * identity.user_roles.user_id's reference to identity.users(id) (01:249-251) raises for a user id
 * that does not exist. Quoted here, not invented, and used to prove the error that surfaces from
 * a NON-SoD failure is the genuine database error rather than a relabelled one.
 */
const FOREIGN_KEY_VIOLATION_SQLSTATE = '23503';

/**
 * SQLSTATE of a plpgsql `raise exception` with no explicit condition — what identity.check_sod()
 * raises (13B:549), and the ONLY SQLSTATE src/rbac.ts may translate into SodViolationError. Named
 * here so the discrimination test can assert the non-SoD failure does not carry it.
 */
const PLPGSQL_RAISE_EXCEPTION_SQLSTATE = 'P0001';

const pool = new Pool({
  host: process.env['PGHOST'] ?? 'localhost',
  port: Number(process.env['PGPORT'] ?? '5432'),
  user: process.env['PGUSER'] ?? 'postgres',
  database: process.env['PGDATABASE'] ?? 'pgeos',
  max: 10,
});

const fixtureEmails: string[] = [];
const fixturePermissionCodes: string[] = [];

async function createFixtureUser(): Promise<{ id: string; email: string }> {
  const email = `pg-eos-0.17-rbac-${randomUUID()}@example.invalid`;
  fixtureEmails.push(email);
  const result: QueryResult<{ id: string }> = await pool.query(
    `insert into identity.users (email, full_name_ar, user_type, is_active)
     values ($1, $2, 'internal', true)
     returning id`,
    [email, 'مستخدم اختبار — WBS 0.17'],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('fixture user insert returned no row');
  }
  return { id: row.id, email };
}

async function roleIdOf(code: string): Promise<string> {
  const result: QueryResult<{ id: string }> = await pool.query(
    'select id from identity.roles where code = $1',
    [code],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`seeded role missing from identity.roles: ${code} (13B:446-473)`);
  }
  return row.id;
}

/**
 * How many ACTIVE (revoked_at is null — 01:249-257) identity.user_roles rows the user holds for
 * `roleCode`. The `revoked_at is null` filter is the one the name promises and the one
 * identity.check_sod() itself applies (13B:547), so a count taken here means the same thing the
 * trigger means by "already holds".
 */
async function activeUserRoleCount(userId: string, roleCode: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n
       from identity.user_roles ur
       join identity.roles r on r.id = ur.role_id
      where ur.user_id = $1 and r.code = $2 and ur.revoked_at is null`,
    [userId, roleCode],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('count query returned no row');
  }
  return Number(row.n);
}

/** Every active identity.user_roles row of the user, whatever the role — used to prove that a
 *  refused assignment left nothing at all behind. */
async function activeUserRoleTotal(userId: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n
       from identity.user_roles
      where user_id = $1 and revoked_at is null`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('count query returned no row');
  }
  return Number(row.n);
}

/** The rejection of `promise`, or a failure if it resolved. Returned as `unknown` so each test
 *  states for itself what the error must and must not be. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/**
 * Walks an error's `cause` chain, exactly as src/rbac.ts's own discrimination does: drizzle wraps
 * a failing query and carries pg's DatabaseError — the one holding the SQLSTATE — underneath. A
 * test that inspected only the outermost error would be blind to the same thing the production
 * matcher looks at. Bounded by `seen`, so a cyclic chain cannot spin.
 */
function errorChain(error: unknown): Error[] {
  const seen = new Set<unknown>();
  const chain: Error[] = [];
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

function sqlStatesIn(error: unknown): string[] {
  return errorChain(error)
    .map((link) => ('code' in link ? link.code : undefined))
    .filter((code): code is string => typeof code === 'string');
}

function messagesIn(error: unknown): string {
  return errorChain(error)
    .map((link) => link.message)
    .join(' | ');
}

interface SodRule {
  role_a: string;
  role_b: string;
}

async function readActiveSodRules(): Promise<SodRule[]> {
  const result: QueryResult<SodRule> = await pool.query(
    'select role_a, role_b from identity.sod_rules where is_active order by role_a, role_b',
  );
  return result.rows;
}

beforeAll(async () => {
  for (const code of [ROLE_CFO, ROLE_ACCOUNTANT, ROLE_WH_MGR, ROLE_HR_MGR]) {
    await roleIdOf(code);
  }
});

afterAll(async () => {
  if (fixturePermissionCodes.length > 0) {
    // role_permissions has `on delete cascade` from permissions, but the link is deleted
    // explicitly first so this cleanup does not silently depend on that.
    await pool.query(
      `delete from identity.role_permissions
        where permission_id in (select id from identity.permissions where code = any($1::text[]))`,
      [fixturePermissionCodes],
    );
    await pool.query('delete from identity.permissions where code = any($1::text[])', [
      fixturePermissionCodes,
    ]);
  }
  if (fixtureEmails.length > 0) {
    // identity.user_roles.user_id and identity.user_entities.user_id are both `on delete cascade`.
    await pool.query('delete from identity.users where email = any($1::text[])', [fixtureEmails]);
  }
  await pool.end();
});

describe('RBAC — hasPermission wraps platform.has_perm() (WBS 0.17 brief, Feature: RBAC / SoD evaluation)', () => {
  it('returns true for a user holding a role that identity.role_permissions grants that permission code', async () => {
    const user = await createFixtureUser();

    // A probe permission of this run only — randomUUID()-suffixed so no concurrent run, and no
    // production permission code, can collide with it. It is linked to a seeded role that appears
    // in no identity.sod_rules pair, so granting it cannot disturb anything else.
    const permissionCode = `identity.test_probe.read.${randomUUID()}`;
    fixturePermissionCodes.push(permissionCode);
    const permission: QueryResult<{ id: string }> = await pool.query(
      `insert into identity.permissions (code, module, object, action, description)
       values ($1, 'identity', 'test_probe', 'read', 'WBS 0.17 pg-tester probe permission')
       returning id`,
      [permissionCode],
    );
    const permissionRow = permission.rows[0];
    if (!permissionRow) {
      throw new Error('fixture permission insert returned no row');
    }
    await pool.query(
      'insert into identity.role_permissions (role_id, permission_id) values ($1, $2)',
      [await roleIdOf(ROLE_HR_MGR), permissionRow.id],
    );

    await assignRole(user.id, ROLE_HR_MGR, null);

    await expect(hasPermission(user.id, permissionCode)).resolves.toBe(true);
  });

  it('returns false for a user holding no role at all, and false for a code no role of the user grants', async () => {
    const rolelessUser = await createFixtureUser();
    const roleHoldingUser = await createFixtureUser();
    await assignRole(roleHoldingUser.id, ROLE_WH_MGR, null);

    const ungrantedCode = `identity.test_probe.never_granted.${randomUUID()}`;

    await expect(hasPermission(rolelessUser.id, ungrantedCode)).resolves.toBe(false);
    await expect(hasPermission(roleHoldingUser.id, ungrantedCode)).resolves.toBe(false);
  });
});

describe('SoD — assignRole surfaces the identity.check_sod() rejection (13B:538-555)', () => {
  it('rejects ACCOUNTANT with SodViolationError for a user who already holds CFO, and creates no identity.user_roles row for that pairing', async () => {
    const user = await createFixtureUser();
    await assignRole(user.id, ROLE_CFO, null);
    expect(await activeUserRoleCount(user.id, ROLE_CFO)).toBe(1);

    await expect(assignRole(user.id, ROLE_ACCOUNTANT, null)).rejects.toBeInstanceOf(
      SodViolationError,
    );

    expect(await activeUserRoleCount(user.id, ROLE_ACCOUNTANT)).toBe(0);
    // The first, legitimate assignment is untouched — the rejection must not have rolled back or
    // "repaired" anything beyond the refused insert.
    expect(await activeUserRoleCount(user.id, ROLE_CFO)).toBe(1);
  });

  it('rejects CFO with SodViolationError for a user who already holds ACCOUNTANT — the rule is symmetric in role_a / role_b', async () => {
    const user = await createFixtureUser();
    await assignRole(user.id, ROLE_ACCOUNTANT, null);
    expect(await activeUserRoleCount(user.id, ROLE_ACCOUNTANT)).toBe(1);

    await expect(assignRole(user.id, ROLE_CFO, null)).rejects.toBeInstanceOf(SodViolationError);

    expect(await activeUserRoleCount(user.id, ROLE_CFO)).toBe(0);
  });

  it('grants WH_MGR — a role in no active identity.sod_rules pair — and leaves an active (revoked_at is null) identity.user_roles row', async () => {
    const rules = await readActiveSodRules();
    // Proves the premise "a user holds no role that conflicts with WH_MGR" against the table
    // itself rather than assuming it: if a future seed adds a WH_MGR conflict, this fails loudly
    // instead of the scenario quietly testing the wrong thing.
    expect(
      rules.filter((r) => r.role_a === ROLE_WH_MGR || r.role_b === ROLE_WH_MGR),
    ).toHaveLength(0);

    const user = await createFixtureUser();

    const assigned = await assignRole(user.id, ROLE_WH_MGR, null);

    expect(assigned.userRoleId).toEqual(expect.any(String));

    const row: QueryResult<{ id: string; revoked_at: Date | null; granted_at: Date }> =
      await pool.query(
        `select ur.id, ur.revoked_at, ur.granted_at
           from identity.user_roles ur
           join identity.roles r on r.id = ur.role_id
          where ur.user_id = $1 and r.code = $2`,
        [user.id, ROLE_WH_MGR],
      );
    expect(row.rows).toHaveLength(1);
    const userRole = row.rows[0];
    if (!userRole) {
      throw new Error('expected one identity.user_roles row for the granted role');
    }
    expect(userRole.id).toBe(assigned.userRoleId);
    expect(userRole.revoked_at).toBeNull();
  });

  it('property: for EVERY active identity.sod_rules pair, holding role_a then assigning role_b is rejected, and holding role_b then assigning role_a is rejected too', async () => {
    const rules = await readActiveSodRules();
    // The count is read from the table, never asserted as a literal (the WBS 0.17 brief is
    // explicit: "do not hardcode the count from this brief, read it from the table"). This
    // assertion only stops an empty table from making the property vacuously true.
    expect(rules.length).toBeGreaterThan(0);

    for (const rule of rules) {
      // A fresh user per direction: the property is about the PAIR, not about accumulated state.
      const forward = await createFixtureUser();
      await assignRole(forward.id, rule.role_a, null);
      await expect(assignRole(forward.id, rule.role_b, null)).rejects.toBeInstanceOf(
        SodViolationError,
      );
      expect(await activeUserRoleCount(forward.id, rule.role_b)).toBe(0);

      const reverse = await createFixtureUser();
      await assignRole(reverse.id, rule.role_b, null);
      await expect(assignRole(reverse.id, rule.role_a, null)).rejects.toBeInstanceOf(
        SodViolationError,
      );
      expect(await activeUserRoleCount(reverse.id, rule.role_a)).toBe(0);
    }
  });
});

describe('assignRole failure discrimination — only trg_sod is an SoD violation (pg-reviewer round 1, finding 7)', () => {
  // src/rbac.ts translates a failed identity.user_roles insert into SodViolationError ONLY when the
  // error chain carries SQLSTATE P0001 together with identity.check_sod()'s own message fragment
  // (13B:549). Two delivered branches of that logic shipped without a test: the unknown-role-code
  // guard, and the selectivity of the matcher itself. Both are covered here. Neither test
  // re-implements the matcher — each drives a real failure through the real database and asserts
  // what surfaces.

  it('rejects an unknown role code with a clear error naming the code — not silently, and not as a SodViolationError', async () => {
    const user = await createFixtureUser();
    // randomUUID()-suffixed, so no identity.roles row can exist for it — asserted, not assumed.
    const unknownRoleCode = `NO_SUCH_ROLE_${randomUUID()}`;
    const existing: QueryResult<{ id: string }> = await pool.query(
      'select id from identity.roles where code = $1',
      [unknownRoleCode],
    );
    expect(existing.rows).toHaveLength(0);

    const error = await rejectionOf(assignRole(user.id, unknownRoleCode, null));

    // "Clear" is asserted as: it is an Error, it names the role code the caller passed, and it
    // says what was not found. A silent resolve, or a resolve with an empty result, fails at
    // rejectionOf above — a no-op must not be reported as a successful grant.
    expect(error).toBeInstanceOf(Error);
    expect(messagesIn(error)).toContain(unknownRoleCode);
    // Mislabelling this as an SoD refusal would tell an operator a conflict rule blocked a grant
    // that in fact addressed a role that does not exist.
    expect(error).not.toBeInstanceOf(SodViolationError);

    expect(await activeUserRoleTotal(user.id)).toBe(0);
  });

  it('surfaces a non-SoD identity.user_roles failure (foreign-key violation on user_id) unchanged — the P0001 matcher does not relabel it SodViolationError', async () => {
    // A user id of the right type that no identity.users row carries. The role code is real and
    // conflicts with nothing, so the insert…select does produce a row and the insert is genuinely
    // attempted: trg_sod fires first, finds no existing user_roles row for this user, and returns
    // NEW without raising — then the user_id foreign key (01:250) rejects the insert. That is a
    // real, non-SoD failure on exactly the table whose errors assignRole inspects.
    const nonExistentUserId = randomUUID();

    const error = await rejectionOf(assignRole(nonExistentUserId, ROLE_WH_MGR, null));

    // The finding: prove the discrimination is SELECTIVE, not merely present.
    expect(error).not.toBeInstanceOf(SodViolationError);
    // And prove the failure really was the foreign key — otherwise "not SodViolationError" could
    // pass for the wrong reason (e.g. the insert never happening at all).
    expect(sqlStatesIn(error)).toContain(FOREIGN_KEY_VIOLATION_SQLSTATE);
    expect(sqlStatesIn(error)).not.toContain(PLPGSQL_RAISE_EXCEPTION_SQLSTATE);
    // No trailing activeUserRoleTotal(nonExistentUserId) check here (round-2 review finding 3,
    // minor): identity.user_roles.user_id references identity.users(id) (01-Data-Model.sql:250),
    // so no row for a non-existent user id can ever exist — asserting it would be vacuously true
    // regardless of whether assignRole's discrimination logic is correct.
  });
});

describe('RBAC — listRoles and allowedEntities (WBS 0.17 brief, Deliver: src/rbac.ts)', () => {
  // These two exports are named in the brief's Deliver list but have no Gherkin scenario of their
  // own. They are covered here against what the schema already defines — identity.user_roles for
  // the first, platform.allowed_entities() over identity.user_entities for the second — so no
  // delivered export ships untested. No behaviour beyond those two definitions is asserted.

  it('listRoles returns the codes of the roles the user actively holds, and nothing for a user with none', async () => {
    const rolelessUser = await createFixtureUser();
    await expect(listRoles(rolelessUser.id)).resolves.toEqual([]);

    const user = await createFixtureUser();
    await assignRole(user.id, ROLE_WH_MGR, null);

    await expect(listRoles(user.id)).resolves.toEqual([ROLE_WH_MGR]);
  });

  it('allowedEntities returns exactly the platform.entities ids present in identity.user_entities for that user', async () => {
    const user = await createFixtureUser();
    await expect(allowedEntities(user.id)).resolves.toEqual([]);

    // An entity id read from the seeded platform.entities rows — never a hardcoded uuid.
    const entity: QueryResult<{ id: string }> = await pool.query(
      'select id from platform.entities order by code limit 1',
    );
    const entityRow = entity.rows[0];
    if (!entityRow) {
      throw new Error('no seeded platform.entities row to scope the fixture user to');
    }
    await pool.query('insert into identity.user_entities (user_id, entity_id) values ($1, $2)', [
      user.id,
      entityRow.id,
    ]);

    await expect(allowedEntities(user.id)).resolves.toEqual([entityRow.id]);
  });
});
