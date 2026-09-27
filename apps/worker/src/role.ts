// apps/worker/src/role.ts — X part 5b. The worker runs ONLY as the dedicated non-superuser
// service role `pgeos_worker` (migration 0039, ADR-0006 §1, D-183). Mirrors — does not import —
// packages/db/src/client.ts's requireAppUser/assertAppRole (neither is exported by @pg-eos/db):
// a name check BEFORE connecting, a pg_roles check AFTER the first connect. With
// PG_APP_USER=pgeos_app a worker would start and silently relay only entity_id-null rows
// (relay.ts "RLS / SUPERUSER GAP"), so every role but pgeos_worker is refused by name.

import type { Pool } from 'pg';

export const WORKER_ROLE = 'pgeos_worker';

const ROLE_ENV_KEY = 'PG_APP_USER';

export type WorkerEnv = Readonly<Record<string, string | undefined>>;

/** Before any connection: PG_APP_USER must name WORKER_ROLE exactly. Throws otherwise. */
export function assertWorkerRole(env: WorkerEnv): void {
  const configured = env[ROLE_ENV_KEY];
  if (configured !== WORKER_ROLE) {
    throw new Error(
      `${ROLE_ENV_KEY}=${configured ?? '(unset)'} refused: the outbox worker runs only as the non-superuser service role ${WORKER_ROLE} (ADR-0006 §1, migration 0039)`,
    );
  }
}

interface ConnectedRoleRow {
  readonly ok: boolean | null;
  readonly rolsuper: boolean | null;
  readonly rolbypassrls: boolean | null;
}

/** After the first connect: the session must BE WORKER_ROLE and that role must be neither superuser
 *  nor BYPASSRLS. Fail closed — zero rows or any null value is a refusal. */
export async function assertConnectedRole(pool: Pool): Promise<void> {
  const result = await pool.query<ConnectedRoleRow>(
    'select current_user = $1 as ok, rolsuper, rolbypassrls from pg_roles where rolname = current_user',
    [WORKER_ROLE],
  );
  const row = result.rows[0];
  const passes = row !== undefined && row.ok === true && row.rolsuper === false && row.rolbypassrls === false;
  if (!passes) {
    throw new Error(
      `the worker pool is not connected as the non-superuser, non-BYPASSRLS service role ${WORKER_ROLE} (ADR-0006 §1, migration 0039)`,
    );
  }
}
