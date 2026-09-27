#!/usr/bin/env bash
# scripts/set-role-passwords.sh — X part 5c. Sets the passwords of pgeos_app and pgeos_worker from
# the host environment (doc 42 §4.3); never from the repository, the image, argv or the server log.
#   PG_APP_PASSWORD=… PG_WORKER_PASSWORD=… PGUSER=postgres bash scripts/set-role-passwords.sh
# Values reach psql only through \getenv in a quoted heredoc on stdin; statement logging is off for
# the ALTERs (superuser). Loopback only unless PG_ROLE_PASSWORDS_ALLOW_REMOTE=1 (Tier 0 VM → compose).
# Rerunnable. Prints one line per role, never a value.
set -euo pipefail
readonly EXIT_USAGE=2
for var in PG_APP_PASSWORD PG_WORKER_PASSWORD; do
  if [[ -z "${!var:-}" ]]; then
    echo "set-role-passwords: ${var} is unset or empty — nothing changed" >&2
    exit "$EXIT_USAGE"
  fi
done
remote=""
case "${PGHOST:-}" in '' | localhost | 127.0.0.1 | /*) ;; *) remote="PGHOST=${PGHOST}" ;; esac
[[ -n "${PGHOSTADDR:-}" ]] && remote="PGHOSTADDR=${PGHOSTADDR}"
[[ -n "${PGSERVICE:-}" ]] && remote="PGSERVICE=${PGSERVICE}"
if [[ -n "$remote" && "${PG_ROLE_PASSWORDS_ALLOW_REMOTE:-}" != "1" ]]; then
  echo "set-role-passwords: ${remote} is not loopback; set PG_ROLE_PASSWORDS_ALLOW_REMOTE=1 to allow" >&2
  exit "$EXIT_USAGE"
fi
psql -X -q <<'SQL'
\set ON_ERROR_STOP on
\getenv app_pw PG_APP_PASSWORD
\getenv worker_pw PG_WORKER_PASSWORD
begin;
set local log_statement = 'none';
set local log_min_error_statement = 'panic';
set local log_min_duration_statement = -1;
alter role pgeos_app password :'app_pw';
alter role pgeos_worker password :'worker_pw';
commit;
SQL
echo "pgeos_app: password set"
echo "pgeos_worker: password set"
