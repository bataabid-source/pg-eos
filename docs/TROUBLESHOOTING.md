# Troubleshooting

This guide records the most common operational problems seen in pg-eos and the quickest path to resolution.

## 1. RLS permission denied (42501)

**Symptom**
- DB action fails with a permission or policy denial
- often seen when the app role is wrong or the security definer path is missing

**Check**

```bash
# confirm the app role in use
echo "$PG_APP_USER"

# verify the role is not a superuser and is the expected service role
# review the migration and withContext usage in the relevant module
```

**Likely causes**
- wrong PG_APP_USER value
- missing withContext wrapper
- security definer function not using the expected binding
- entity scope mismatch for the command

## 2. Unique constraint violation (23505)

**Symptom**
- event replay or retry hits a duplicate-state path

**Check**
- confirm deduplication logic is present
- confirm the idempotency key or unique invariant is honored
- inspect whether a retry is re-inserting the same aggregate row

## 3. Missing scenario or `NOT BUILT` red step

**Symptom**
- scenario is red because the required DB row or backend step has not been built yet

**Check**
- review the acceptance scenario in docs/STREAMS.md
- confirm the correct lane lock is active
- confirm the slice's required migration and backend step exist
- do not weaken the assertion to make the scenario pass

## 4. Guard failures

**Symptom**
- governance checks fail in the guard suite or local validation

**Check**

```bash
pnpm guards:run
```

Then isolate the failing guard and fix the root cause rather than changing the test contract.

## 5. Local setup issues

**Symptom**
- app fails to start or schema does not apply

**Check**

```bash
pnpm install
bash scripts/set-role-passwords.sh
```

Then rerun the schema apply and app startup commands from the relevant README and script definitions.

## 6. CI failures after a merge candidate looks correct

**Symptom**
- local tests pass but CI fails

**Check**
- verify branch is rebased on the current main branch
- confirm no hidden frozen-path edits were made
- check the exact gate that failed
- review the latest review verdict and any lock change requirements

## General rule

Do not treat a failing test as a reason to weaken assertions. Fix the code path or the contract that is incorrect.
