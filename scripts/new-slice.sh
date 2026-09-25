#!/usr/bin/env bash
# PG-EOS · new-slice.sh — replicate the golden slice into a new module use case.
#
#   scripts/new-slice.sh <module> <use-case>
#   e.g. scripts/new-slice.sh tms assign-route
#
# WHY THIS SCRIPT EXISTS
#   CLAUDE.md · BUILD METHOD: "GOLDEN SLICE = WBS 2.9 'Receive inbound order.' Built once with
#   full human review. Every later slice replicates its file structure exactly. No file without a
#   counterpart in the golden slice."
#   CLAUDE.md · SPEED AND QUALITY (v5): "every replicated slice starts from it. Hand-made file
#   trees are a review FAIL."
#   So replication must be copy + rename, never reasoning — that is the quota saving.
#
# WHY IT IS A NO-OP TODAY
#   BOOTSTRAP-v5 §9: "scripts/new-slice.sh exists and is a no-op until 2.9 is accepted (prints
#   'golden slice not accepted yet')." EXECUTION-MASTER-v4 §3.5: the GM reviews 2.9 personally and
#   "nothing replicates before acceptance." The gate is the presence of the file
#   `.golden-slice-accepted` at the repository root. That file IS COMMITTED — it is the record of
#   the GM's acceptance, not a local artefact, and .gitignore must never list it.
#
# INTENDED BEHAVIOUR ONCE `.golden-slice-accepted` EXISTS (implemented below)
#   1. Refuse unless the golden slice tree is present and the target does not already exist.
#   2. Copy, from the golden slice, the five directories the slice is made of —
#        modules/wms/domain/receive-inbound        → modules/<module>/domain/<use-case>
#        modules/wms/application/receive-inbound   → modules/<module>/application/<use-case>
#        modules/wms/infrastructure/receive-inbound→ modules/<module>/infrastructure/<use-case>
#        modules/wms/api/receive-inbound           → modules/<module>/api/<use-case>
#        modules/wms/tests/receive-inbound         → modules/<module>/tests/<use-case>
#      plus the contract  packages/contracts/wms/receive-inbound.ts
#                      → packages/contracts/<module>/<use-case>.ts
#      plus the i18n key block in packages/i18n/<lang>/<module>.json for ar en hi ur bn am.
#   3. sed-rename inside every copied file, in this order (longest first, so no partial hits):
#        receive-inbound → <use-case>            (kebab: paths, i18n keys, route segments)
#        receive_inbound → <use_case>            (snake: SQL, column and event names)
#        receiveInbound  → <useCase>             (camel: symbols, fields)
#        ReceiveInbound  → <UseCase>             (pascal: classes, types, XState machines)
#        RECEIVE_INBOUND → <USE_CASE>            (const: event names, error codes)
#        wms.            → <module>.             (schema-qualified names)
#        modules/wms/    → modules/<module>/     (import paths)
#      and rename the files themselves by the same rules.
#   4. Leave every TODO marker the golden slice carries; pg-tester fills the tests first (RED),
#      pg-backend then makes them green. The script writes no logic of its own.
#   5. Print the produced file list so it can be pasted into the brief's `Deliver:` line.
#
# It never touches database/schema/*, packages/contracts/_shared/*, CLAUDE.md or .claude/*.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATE="$ROOT/.golden-slice-accepted"

GOLDEN_MODULE="wms"
GOLDEN_SLUG="receive-inbound"
LAYERS="domain application infrastructure api tests"
LANGS="ar en hi ur bn am"   # six field-app languages — SCR-I18N-01 / D-001 (am added: lane blocker (b))

if [ ! -f "$GATE" ]; then
  echo "golden slice not accepted yet"
  echo "  WBS 2.9 must be built, reviewed on opus and accepted by the GM before anything replicates."
  echo "  The acceptance record is the committed file .golden-slice-accepted at the repository root."
  echo "  See EXECUTION-MASTER-v4 §3.5 and BOOTSTRAP-v5 §9."
  exit 0
fi

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/new-slice.sh <module> <use-case>" >&2
  echo "       module  : one of identity platform catalog sales wms tms cc billing hr fleet housing partners admin imile governance" >&2
  echo "       use-case: kebab-case, e.g. assign-route" >&2
  exit 2
fi

MODULE="$1"
SLUG="$2"

case "$MODULE" in
  identity|platform|catalog|sales|wms|tms|cc|billing|hr|fleet|housing|partners|admin|imile|governance) ;;
  *) echo "new-slice: '$MODULE' is not one of the fifteen modules (BOOTSTRAP-v5 §7)." >&2; exit 2 ;;
esac
case "$SLUG" in
  [a-z]*[a-z0-9]) : ;;
  *) echo "new-slice: '<use-case>' must be kebab-case, e.g. assign-route." >&2; exit 2 ;;
esac
case "$SLUG" in *[!a-z0-9-]*) echo "new-slice: '<use-case>' must be kebab-case." >&2; exit 2 ;; esac

# ---- name forms derived from the two arguments ---------------------------
snake="${SLUG//-/_}"
GOLDEN_SNAKE="${GOLDEN_SLUG//-/_}"
pascal="$(printf '%s' "$SLUG" | awk -F- '{for(i=1;i<=NF;i++) printf toupper(substr($i,1,1)) substr($i,2)}')"
GOLDEN_PASCAL="$(printf '%s' "$GOLDEN_SLUG" | awk -F- '{for(i=1;i<=NF;i++) printf toupper(substr($i,1,1)) substr($i,2)}')"
camel="$(printf '%s' "$pascal" | awk '{print tolower(substr($0,1,1)) substr($0,2)}')"
GOLDEN_CAMEL="$(printf '%s' "$GOLDEN_PASCAL" | awk '{print tolower(substr($0,1,1)) substr($0,2)}')"
upper="$(printf '%s' "$snake" | tr '[:lower:]' '[:upper:]')"
GOLDEN_UPPER="$(printf '%s' "$GOLDEN_SNAKE" | tr '[:lower:]' '[:upper:]')"

# ---- preconditions -------------------------------------------------------
missing=0
for layer in $LAYERS; do
  src="$ROOT/modules/$GOLDEN_MODULE/$layer/$GOLDEN_SLUG"
  [ -d "$src" ] || { echo "new-slice: golden slice missing: modules/$GOLDEN_MODULE/$layer/$GOLDEN_SLUG" >&2; missing=1; }
done
[ -f "$ROOT/packages/contracts/$GOLDEN_MODULE/$GOLDEN_SLUG.ts" ] || {
  echo "new-slice: golden contract missing: packages/contracts/$GOLDEN_MODULE/$GOLDEN_SLUG.ts" >&2; missing=1; }
[ "$missing" -eq 0 ] || exit 1

for layer in $LAYERS; do
  dst="$ROOT/modules/$MODULE/$layer/$SLUG"
  [ ! -e "$dst" ] || { echo "new-slice: refusing to overwrite modules/$MODULE/$layer/$SLUG" >&2; exit 1; }
done
[ ! -e "$ROOT/packages/contracts/$MODULE/$SLUG.ts" ] || {
  echo "new-slice: refusing to overwrite packages/contracts/$MODULE/$SLUG.ts" >&2; exit 1; }

# ---- copy ----------------------------------------------------------------
produced=""
for layer in $LAYERS; do
  mkdir -p "$ROOT/modules/$MODULE/$layer"
  cp -R "$ROOT/modules/$GOLDEN_MODULE/$layer/$GOLDEN_SLUG" "$ROOT/modules/$MODULE/$layer/$SLUG"
  produced="$produced modules/$MODULE/$layer/$SLUG"
done
mkdir -p "$ROOT/packages/contracts/$MODULE"
cp "$ROOT/packages/contracts/$GOLDEN_MODULE/$GOLDEN_SLUG.ts" "$ROOT/packages/contracts/$MODULE/$SLUG.ts"
produced="$produced packages/contracts/$MODULE/$SLUG.ts"

# ---- rename inside the files (longest form first) ------------------------
rename_in_place() {
  sed -i.bak \
    -e "s|${GOLDEN_SLUG}|${SLUG}|g" \
    -e "s|${GOLDEN_SNAKE}|${snake}|g" \
    -e "s|${GOLDEN_PASCAL}|${pascal}|g" \
    -e "s|${GOLDEN_CAMEL}|${camel}|g" \
    -e "s|${GOLDEN_UPPER}|${upper}|g" \
    -e "s|${GOLDEN_MODULE}\\.|${MODULE}.|g" \
    -e "s|modules/${GOLDEN_MODULE}/|modules/${MODULE}/|g" \
    -e "s|contracts/${GOLDEN_MODULE}/|contracts/${MODULE}/|g" \
    "$1"
  rm -f "$1.bak"
}

for layer in $LAYERS; do
  find "$ROOT/modules/$MODULE/$layer/$SLUG" -type f -print0 | while IFS= read -r -d '' f; do
    rename_in_place "$f"
  done
  # rename the files themselves
  find "$ROOT/modules/$MODULE/$layer/$SLUG" -depth -name "*${GOLDEN_SLUG}*" -print0 |
    while IFS= read -r -d '' f; do mv "$f" "${f//$GOLDEN_SLUG/$SLUG}"; done
  find "$ROOT/modules/$MODULE/$layer/$SLUG" -depth -name "*${GOLDEN_PASCAL}*" -print0 |
    while IFS= read -r -d '' f; do mv "$f" "${f//$GOLDEN_PASCAL/$pascal}"; done
done
rename_in_place "$ROOT/packages/contracts/$MODULE/$SLUG.ts"

# ---- contracts package registration (Master task, reviewer finding on lane 2 / 3.3, 2026-09-24) ----
# packages/contracts/package.json `exports` and tsconfig.json `include` are frozen for lanes; the
# script (owned by the Master) registers the new subpath export and module include so a lane never
# has to touch them. Idempotent: skips entries that already exist.
node - "$ROOT/packages/contracts/package.json" "$MODULE" "$SLUG" <<'NODE'
const fs = require('fs'); const [file, mod, slug] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, 'utf8')); pkg.exports = pkg.exports || {};
const key = `./${mod}/${slug}`;
if (!pkg.exports[key]) { pkg.exports[key] = { types: `./dist/${mod}/${slug}.d.ts`, default: `./dist/${mod}/${slug}.js` };
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n'); console.log(`new-slice: registered export ${key} in packages/contracts/package.json`); }
NODE
tsc_cfg="$ROOT/packages/contracts/tsconfig.json"
if ! grep -q "\"$MODULE/\*\*/\*.ts\"" "$tsc_cfg"; then
  sed -i "s#\"wms/\*\*/\*.ts\"#\"wms/**/*.ts\",\n    \"$MODULE/**/*.ts\"#" "$tsc_cfg"
  echo "new-slice: added $MODULE/**/*.ts to packages/contracts/tsconfig.json include"
fi
produced="$produced packages/contracts/package.json packages/contracts/tsconfig.json"

# ---- module test include registration (D-179, 2026-09-25) ----------------
# A module whose tsconfig.test.json lists tests per use case (wms shape) gets "tests/<slug>/**/*.ts"
# added here, so a lane holding only a use-case lock never edits the file by hand. Idempotent; a
# module that already includes "tests/**/*.ts" needs nothing.
mod_tsc_test="$ROOT/modules/$MODULE/tsconfig.test.json"
if [ -f "$mod_tsc_test" ] && ! grep -q '"tests/\*\*/\*\.ts"' "$mod_tsc_test" && ! grep -q "\"tests/$SLUG/\*\*/\*.ts\"" "$mod_tsc_test"; then
  sed -i "s#\"vitest.config.ts\"#\"tests/$SLUG/**/*.ts\",\n    \"vitest.config.ts\"#" "$mod_tsc_test"
  echo "new-slice: added tests/$SLUG/**/*.ts to modules/$MODULE/tsconfig.test.json include"
  produced="$produced modules/$MODULE/tsconfig.test.json"
fi

# ---- module scaffold (lane blocker (c), 2026-09-24) -----------------------
# A module with no golden counterpart (anything but identity platform sales wms today) gets its
# package shell copied from the golden module BEFORE the five layers are copied: package.json,
# tsconfig.json, tsconfig.test.json, vitest.config.ts and an index.ts barrel, with @pg-eos/wms →
# @pg-eos/<module>. This is the ONLY way a new module package is created (CLAUDE.md: hand-made
# trees are a review FAIL). After the copy, `pnpm install` links the new workspace package; the
# boundaries rule (eslint.config.mjs) matches modules/* generically, so nothing else is registered.
scaffold_module() {
  local mdir="$ROOT/modules/$MODULE" gdir="$ROOT/modules/$GOLDEN_MODULE"
  # the layer copy above already created modules/<module>/<layer>; the package shell (package.json)
  # is what decides whether the module exists as a workspace package.
  [ -f "$mdir/package.json" ] && return 0
  mkdir -p "$mdir"
  for f in package.json tsconfig.json tsconfig.test.json vitest.config.ts; do
    cp "$gdir/$f" "$mdir/$f"
    rename_in_place "$mdir/$f"
    sed -i "s#\"@pg-eos/${GOLDEN_MODULE}\"#\"@pg-eos/${MODULE}\"#g" "$mdir/$f"   # workspace package name
    produced="$produced modules/$MODULE/$f"
  done
  # tsconfig.test.json lists the golden slice's own test folders; keep only the generic ones.
  # and drop the golden file's own review comments (they reference modules/wms and fix round F20).
  sed -i '/^[[:space:]]*\/\/ /d' "$mdir/tsconfig.test.json"
  sed -i "s#\"tests/${SLUG}/\*\*/\*.ts\"#\"tests/**/*.ts\"#; /\"tests\/integration\/\*\*\/\*.ts\",/d; /\"tests\/unit\/\*\*\/\*.ts\",/d" "$mdir/tsconfig.test.json"
  cat > "$mdir/index.ts" <<EOF
// modules/$MODULE — package shell created by scripts/new-slice.sh (lane blocker (c), 2026-09-24),
// copied from the golden module's shell (modules/$GOLDEN_MODULE). Public barrel: every use case
// re-exports its application layer here. Never hand-made (CLAUDE.md · SPEED AND QUALITY).
export * from './application/$SLUG/index.js';
EOF
  produced="$produced modules/$MODULE/index.ts"
  mkdir -p "$ROOT/packages/contracts/$MODULE"
  echo "new-slice: scaffolded module package modules/$MODULE (run: pnpm install)"
}
scaffold_module

# ---- i18n key block ------------------------------------------------------
for lang in $LANGS; do
  src="$ROOT/packages/i18n/$lang/$GOLDEN_MODULE.json"
  dst="$ROOT/packages/i18n/$lang/$MODULE.json"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    rename_in_place "$dst"
    produced="$produced packages/i18n/$lang/$MODULE.json"
  fi
done

echo "new-slice: replicated ${GOLDEN_MODULE}/${GOLDEN_SLUG} → ${MODULE}/${SLUG}"
echo "Deliver:"
for p in $produced; do echo "  $p"; done
echo "Next: pg-tester writes the RED tests, then pg-backend makes them green. No file was given logic here."
