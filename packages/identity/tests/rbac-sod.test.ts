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

async function activeUserRoleCount(userId: string, roleCode: string): Promise<number> {
  const result: QueryResult<{ n: string }> = await pool.query(
    `select count(*)::text as n
       from identity.user_roles ur
       join identity.roles r on r.id = ur.role_id
      where ur.user_id = $1 and r.code = $2`,
    [userId, roleCode],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('count query returned no row');
  }
  return Number(row.n);
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
