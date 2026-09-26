# SLICE BRIEF — WBS 2.16 part 1a-2 · PDA offline queue + PWA manifest/service-worker + deferred kiosk-mode tests

builder: pg-frontend

Task: 2.16 part 1a-2 — three items, all filed against the same `pda` lock at part 1a's own close
(CHANGELOG "2.16 part 1a"; MASTER_BACKLOG): (1) the deferred kiosk-mode test-coverage gap (round-2
finding: `fullscreenchange`-driven button show/hide + `requestFullscreen()` rejection `.catch()` path,
both ADDITIVE — the code is already correct, test-only); (2) the 72-h offline queue (IndexedDB) with
its visible unsynced counter (green 0 / yellow 1-20 / red > 20, doc 40 §D4); (3) the actual PWA
manifest (`manifest.webmanifest`) + service worker, deferred from part 1a because a manifest/SW is
meaningless without the queue it exists to support.
**NOT this part** (unreachable — no shift/login concept exists yet, same class of gap as part 1a's
own "no auth this part"): doc 40 §D4's "shift cannot close with queue > 0" gate — there is no shift
screen to gate. Default, recorded here, one CHANGELOG line, not a G-01 (no schema/business-rule gap
— purely sequencing: the gate needs `2.16 part 1a-3`'s OTP/shift concept first). OTP login itself
stays `2.16 part 1a-3`, PIN login stays `2.16 part 1b` (after SCR-IDN-01) — unchanged from part 1a's
brief, same lock.
Lane: 1      Lock: `pda` (whole-module — `apps/pda` only, unchanged from part 1a)
Owner: WH_MGR      Deps: 2.16 part 1a (DONE-in-part, merged `5e71c96`)
Worktree: `../pg-eos-lane-1`, branch `lane/1-2.16p1a` (from `origin/main`, rebased)
Model routing: pg-tester sonnet → pg-frontend sonnet → pg-reviewer opus, two-round cap (P7). Lane
session sonnet, effort medium — orchestrates only.
No `scripts/new-slice.sh` (frontend app, not a backend use-case tree — same precedent as part 1a).
No migration this part (no DB/schema touched — IndexedDB is client-side only, no server sync
endpoint exists yet to receive queued actions; the queue accumulates entries and exposes the counter,
it does not flush anywhere this part — a later slice, once a real scan/mutation endpoint exists,
wires the flush; recorded here as a Scope default, not a G-01).

## Scope (doc 40 §D4, verbatim in Read ONLY item 2)
- **Offline queue** (`apps/pda/src/offline-queue.ts`): a minimal, dependency-free IndexedDB wrapper
  (one object store, `keyPath: 'id'`, UUID keys via `crypto.randomUUID()`) exposing `enqueue(entry)`,
  `list()`, `count()`, and a `subscribe(onChange)` hook-friendly listener (in-memory `EventTarget`,
  fired after every successful IndexedDB write) — no network/sync logic this part, per the "no flush
  target yet" default above.
- **Unsynced counter** (shell-level, `router.tsx`'s `AppShell`): a small badge next to the kiosk-mode
  button, colored via `queueStatus(count)`: `count === 0` → green, `1-20` → yellow, `> 20` → red
  (doc 40 §D4 verbatim thresholds) — a pure function in `offline-queue.ts`, unit-testable without
  IndexedDB.
- **PWA manifest + service worker**: `vite-plugin-pwa` (new devDependency, declared in
  `package.json`, `registerType: 'autoUpdate'`, precache the built app shell only — `injectManifest`/
  custom runtime caching is out of scope, Scope default) wired into `vite.config.ts`, generating
  `manifest.webmanifest` (name/short_name/icons placeholder/theme colors matching `styles/tokens.css`)
  + `sw.ts` (the plugin's own generated service worker, no hand-written caching logic this part).
- **Deferred kiosk-mode tests** (`apps/pda/tests/shell/kiosk-mode.test.tsx`, EXTEND — do not touch the
  five existing tests): (a) the "Enter kiosk mode" button hides once `fullscreenchange` reports
  `document.fullscreenElement` truthy, and reappears once it reports falsy again (Esc); (b) a rejected
  `requestFullscreen()` promise (spy `mockRejectedValue`) is swallowed — no unhandled rejection, the
  button stays visible, exactly matching `kiosk.ts`'s existing `.catch()` (already-correct code, this
  closes the test-only gap, not a logic change).

## Read ONLY (workers) — 8 files, budget 8/1,000 (P7)
1. `CLAUDE.md`
2. `docs/package/40-Build-Specification-EN.md` lines 420-423 (verbatim — doc 40 §D4, the offline-72h/
   counter-color/shift-close/kiosk lines this slice is scoped against; shift-close is OUT, named above)
3. `apps/pda/src/kiosk.ts` (full file — the existing `registerFullscreenChange`/`isFullscreenActive`
   mechanism the deferred tests exercise; already correct, do not change its logic)
4. `apps/pda/src/router.tsx` (full file — the `AppShell` to extend with the counter badge and the
   `fullscreenActive`-gated button it already renders)
5. `apps/pda/src/i18n/t.ts` (full file — the typed-lookup mechanism; the counter badge needs new keys,
   e.g. `queue.unsynced`, added the same way as part 1a's own eleven keys)
6. `apps/pda/package.json` (short — where `vite-plugin-pwa` is declared)
7. `apps/pda/vite.config.ts` (short — where the plugin is wired)
8. `apps/pda/tests/shell/kiosk-mode.test.tsx` (full file — the five existing tests the two new ones
   are appended after, same `describe` block, same spy-based jsdom pattern)

## Not separately read (viewed directly when editing)
`apps/pda/src/i18n/{ar,en,hi,ur,bn,am}.json` (add the new `queue.unsynced` key, same shape as the
existing eleven), `apps/pda/index.html` (link the generated manifest, viewed directly — trivial), the
six `apps/pda/src/i18n/*.json` files for the exact key-count assertion in `tests/i18n/keys.test.ts`
(pg-tester updates the expected count there, viewed directly, not a design decision).

## Write ONLY
- pg-tester: `apps/pda/tests/**` — extends `tests/shell/kiosk-mode.test.tsx` (2 new tests, existing
  5 untouched), new `tests/shell/offline-queue.test.ts` (IndexedDB queue: enqueue/list/count/subscribe,
  using `fake-indexeddb` as a devDependency — declared, no network), new assertions in
  `tests/shell/routes.test.tsx` or a new `tests/shell/queue-badge.test.tsx` for the counter badge's
  three color states, updates `tests/i18n/keys.test.ts`'s expected key count.
- pg-frontend: `apps/pda/src/offline-queue.ts` (new), `apps/pda/src/router.tsx` (extend `AppShell`
  only — badge + queue subscription), `apps/pda/src/i18n/{t.ts, ar.json, en.json, hi.json, ur.json,
  bn.json, am.json}` (add one key each), `apps/pda/{package.json, vite.config.ts, index.html}`
  (PWA plugin wiring), `apps/pda/public/**` (new — manifest icon placeholders if the plugin needs
  them on disk), `pnpm-lock.yaml` (mechanical, new importer entry — same pattern part 1a's own
  CHANGELOG entry used).
- Lane session only: this brief.
Forbidden for every worker: `apps/admin/**`, `modules/**`, `packages/**`, `database/**`, `docs/**`
other than this brief, `scripts/**`, `CLAUDE.md`, `.claude/**`. No server sync/flush logic, no
shift/login concept, no OTP screen this part (those are 1a-3/1b, same lock, later tasks).

## Master decisions the workers copy (not re-derive)
1. **Queue store shape**: one IndexedDB object store `queue` (db name `pda-offline-queue`), each
   entry `{ id: string, createdAt: string, payload: unknown }` — `payload` is opaque this part (no
   real scan action exists yet to type it); `enqueue` accepts `unknown` and stamps `id`/`createdAt`.
2. **Counter thresholds** (doc 40 §D4 verbatim): `queueStatus(n: number): 'green' | 'yellow' | 'red'`
   — `n === 0` → `'green'`, `1 <= n <= 20` → `'yellow'`, `n > 20` → `'red'`. Pure function, exported
   from `offline-queue.ts`, unit-tested directly (no IndexedDB needed for this one).
3. **No sync/flush this part** — the queue only grows (via `enqueue`, called nowhere yet — no real
   caller exists until a scan/mutation screen is built in a later slice replacing a placeholder
   route). The badge and `count()` are exercised by tests calling `enqueue` directly. Recorded default,
   not a gap: there is nothing to flush TO yet.
4. **PWA plugin scope**: `vite-plugin-pwa` default `generateSW` strategy (not `injectManifest` — no
   custom caching logic this part), `registerType: 'autoUpdate'`, precaching the Vite build output
   only. No push notifications, no background sync API this part (both out of doc 40 §D4's own list).
5. **`fake-indexeddb`** (new test-only devDependency, declared in `package.json`): jsdom has no native
   IndexedDB — this is the standard pattern (same class of choice as part 1a's `requestFullscreen`
   jsdom stub), imported once in `test-setup.ts` alongside the existing Testing-Library setup.

## Acceptance criterion (doc 38 row 2.16 — still a step toward the row's own full acceptance; "scan
## response ≤ 1.0 s" stays unreachable until a real scan screen exists, unchanged from part 1a)
Gates: `pnpm --filter @pg-eos/pda typecheck && lint` green · `pnpm --filter @pg-eos/pda test` green ·
pg-reviewer PASS, two rounds max (P7). No `pnpm guards:run` this part (no DB/schema touched).
