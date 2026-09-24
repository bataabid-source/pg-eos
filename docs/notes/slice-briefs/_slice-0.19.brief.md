# SLICE BRIEF — WBS 0.19 · Admin app shell: navigation, Decision Inbox, empty-state, design system

Task: 0.19 — Admin app shell (D-172 lifts the Phase-0 deferral for this task only)      Lane: 1      Lock: `admin` → `apps/admin/` (tasks/LANE_LOCKS.md)
Owner: SYSADMIN      Deps: 0.17 DONE (mechanisms, `c90dd6e`)      Worktree: `../pg-eos-lane-1`, branch `lane/1` (rebased on origin/main `fd57c61`)
Model routing: pg-tester sonnet → pg-frontend sonnet → pg-tester verify → pg-reviewer opus → pg-scribe sonnet. Lane session sonnet, effort medium (D-174) — orchestrates only.
No golden UI precedent exists (`apps/` is empty repo-wide — this is the FIRST frontend slice). This brief is written with the same care as a golden slice; its resulting tree is the template every later `apps/*` slice replicates (recorded in CHANGELOG, not a formal golden-slice designation — doc 38 names only 2.9 as that).

## Scope taken by the lane (SCOPE DEFAULTS — recorded in CHANGELOG, batched for the GM, not re-argued)
- **No backend endpoint in this slice.** `platform.decisions` (the Decision Inbox source table, doc 40 §D1) lives in schema module `platform`, which `tasks/LANE_LOCKS.md` currently locks to **lane 2** for WBS 5.5a. Lane rule: "a worker needing a file outside its lock STOPS and reports — never widen a lock." This slice therefore ships a **mock/fixture data client** behind a typed port (`DecisionsClient`), swappable for a real HTTP client once (a) a `list-decisions` read query exists under `modules/platform` (future slice, after the platform lock frees) and (b) an actual API host exists (today NO NestJS app exists anywhere in the workspace — the golden slice's own header says so verbatim). Batched GM question: authorise that follow-up slice once lane 2 releases `platform`.
- **"Decide inline" (doc 40 §D1) is OUT of scope.** The acceptance line is only "Inbox renders; empty state shows what's missing + owner" — no decide/action wiring. Action buttons render per the doc 29 §6-2 mockup but are **disabled** (`aria-disabled`, `data-testid="decision-action-disabled"`), not wired to any command. Wiring them is a later slice once a `DecideDecision` command/contract exists.
- **i18n resource files are OWNED BY THE APP, not a new `packages/i18n` package.** `packages/i18n/` does not exist anywhere in the repo yet (checked); creating a NEW shared package under `packages/` is a Master-only action (frozen path). i18n JSON lives at `apps/admin/src/i18n/{ar,en,hi,ur,bn,am}.json` — app-local, inside the lane's own lock. Promote to a shared `packages/i18n` only when a second app needs the same keys (Master task).
- **Contract is app-local too**, for the same reason: `apps/admin/src/features/decision-inbox/contract.ts` (Zod schema for the Decision Inbox item), NOT `packages/contracts/platform/*` (that path belongs to the `platform` lock, held by lane 2). Promote alongside the future real endpoint.
- **Acceptance test runner: Vitest + `@testing-library/react` (jsdom), not Playwright.** Guard G15 (Playwright S1–S20) is project-wide "NOT RUNNABLE — runner not present yet"; there is no dev server for this app to run against yet either. Component-level rendering (populated + empty state) is fully testable this way and matches the acceptance criterion's literal wording ("Inbox renders … empty state shows …"). Batched GM question: introduce Playwright now, or defer to the slice that wires the real API.
- **Navigation is a minimal shell**, not a full menu: no other admin screens exist yet to link to. One header (app name + a static "Decision Inbox" nav item, `aria-current` on the active route) + a content region. TanStack Router is used for the one route (`/inbox`) so later slices add routes without restructuring.
- **Design system = a small, real starting point, not the final system:** shadcn/ui primitives (Button, Card, Badge) wired to Tailwind CSS variables (light theme only — no dark-mode requirement in doc 40/29), RTL as the default `dir` (Arabic is the primary locale throughout the package — every `title_ar`/`name_ar` column is non-null while the `_en` twin is nullable), locale switch flips `dir` (`ar`,`ur` = rtl; `en`,`hi`,`bn`,`am` = ltr per Unicode CLDR — informational, not a business rule from docs 01/13/13B/019/40, so recorded as a UI-only default, not a G-01 item).

## Read ONLY (workers) — kept under the 12-file / 1,500-line budget
1. `CLAUDE.md` (ARCHITECTURE, AGENT CONSTRAINTS, BUILD METHOD)
2. `docs/package/40-Build-Specification-EN.md` 404-406 (§D1, quoted below)
3. `docs/package/29-Clean-Slate-Redesign.md` 208-260 (§6-2 mockup — the binding visual for the Decision Inbox card, quoted below — and §6-3 screen inventory, informational only)
4. `database/schema/13B-Schema-Reference-Consolidation.sql` 439-457 (`platform.decisions` DDL, verbatim — the ONLY columns that exist) and 2404-2406 (`chk_decisions_status`: open · decided · expired · cancelled · auto_resolved)
5. `.claude/agents/pg-frontend.md` (role, allowed/forbidden actions, report format — already loaded as the agent's own system prompt, listed here for completeness)
6. `pnpm-workspace.yaml` and `eslint.config.mjs` lines 1-60, 145-160 (`apps/*` is a recognised workspace + boundaries element already — no config change needed)
7. `packages/domain-kit/index.ts` (if a currency-formatting helper exists, reuse it; otherwise a local `formatKwd` constant-driven formatter — no magic numbers)
Nothing else. No golden slice exists to read; do not read `modules/wms/*` — its patterns (XState, ports/adapters, outbox) do not apply to a read-only UI shell with a mock client.

## Write ONLY
- pg-tester: `apps/admin/tests/decision-inbox/*` (component tests) · `apps/admin/src/**/*.test.tsx` colocated is NOT used — tests live under `tests/` per the repo-wide test-path convention (CLAUDE.md · BUILD METHOD "pg-tester writes only test files (tests/**, **/tests/**, *.test.*, *.spec.*, features/**, *.feature)").
- pg-frontend: everything else under `apps/admin/**` (package.json, vite.config.ts, tsconfig.json, tailwind config, `index.html`, `src/**` — app shell, design tokens, i18n JSON, the Decision Inbox feature, the empty-state component, the mock `DecisionsClient`).
Forbidden for every worker: `modules/**`, `database/**`, `packages/**`, `docs/**` (other than reading), `scripts/**`, `CLAUDE.md`, `.claude/**`. A test defect goes back to pg-tester; pg-frontend never edits a test.

## Acceptance criterion (doc 38 row 0.19, verbatim)
"Inbox renders; empty state shows 'what's missing + owner'"
Gates: `pnpm --filter @pg-eos/admin typecheck && lint && test` green · root `npx eslint .` green (boundaries) · no new `packages/*` or `modules/*` file.

## Doc 40 §D1 (verbatim, lines 404-406)
Home for every role = Decision Inbox (`platform.decisions` filtered by role): each item shows facts + financial impact + one action set; decide inline; item disappears on decision; sorted by impact then urgency. Three screen patterns only: list (≤ 6 columns, "needs your action" bar on top), profile (…), action (…). Empty-state component is mandatory: names the missing data and its owner. 57 screens (doc 29 §6-3). Global search Ctrl+K on any number → Trace screen.

## Doc 29 §6-2 (verbatim mockup — the binding visual for one card)
```
┌──────────────────────────────────────────────────────┐
│  صندوق القرارات — <اسم المستخدم>      N تحتاج قرارك  │
├──────────────────────────────────────────────────────┤
│ 🔴 <عنوان القرار>                                    │
│    <الوقائع> · <الأثر المالي> · <السبب/الملاحظة>    │
│    [اعتماد] [رفض] [التفاصيل]                        │
└──────────────────────────────────────────────────────┘
```
Rules from the same section: the inbox IS the home page (no dashboard); every item has exactly one decision and its buttons; deciding acts directly from the inbox (out of scope here — decision above); an item disappears the instant it is decided (out of scope here); order = financial impact then urgency; empty box = the day's decisions are done.

## Master decisions the workers copy (not re-derive)
1. **Stack:** Vite + React 18 + TypeScript + TanStack Router + TanStack Query + Tailwind + shadcn/ui, exactly as CLAUDE.md ARCHITECTURE names. `@pg-eos/admin` package name, private, `type: module`.
2. **`DecisionItem` shape** (app-local contract, `contract.ts`) mirrors `platform.decisions` 1:1, nothing more: `id` (uuid), `kind` (string), `titleAr` (string), `context` (`z.record(z.string(), z.unknown())` — "computed facts only", never free text per the DDL comment), `financialImpact` (nullable numeric(14,3) string), `urgency` (string, default `'normal'` — no CHECK constraint exists on this column, so no enum is asserted; the UI maps known values `'urgent'`/`'high'` to a warm accent and treats anything else, including unknown future values, as neutral — a presentational fallback, not a business rule), `assignedRole` (string), `status` (`z.enum(['open','decided','expired','cancelled','auto_resolved'])` — the real DB CHECK), `dueAt` (nullable ISO datetime string).
3. **`DecisionsClient` port** (`src/features/decision-inbox/client.ts`): one function `listOpenDecisions(role: string): Promise<DecisionItem[]>`. `src/features/decision-inbox/mock-client.ts` implements it from a small in-memory fixture array (3-4 sample items covering both a populated and, via a second export `emptyMockClient`, a zero-item state) — wired through TanStack Query (`useQuery`) so the real client is a one-file swap later.
4. **Empty state** (`src/components/empty-state.tsx`, generic — reusable by later screens): props `{ title: string; missing: string; owner: string }`, renders "لا يوجد ما يحتاج قرارك الآن" style copy (from i18n) plus the two required facts — **what is missing and who owns it**. For the Decision Inbox specifically: when `listOpenDecisions` returns zero items, missing = "لا قرارات مفتوحة" (i18n key `inbox.empty.missing`), owner = the current filtering role itself (i18n key `inbox.empty.owner`, interpolated with the role code) — read literally, the empty state must name *an* owner; since no user/session exists yet (0.17 login is deferred), the role the inbox is filtered by is the only identity available, and is recorded as the default owner value.
5. **Card rendering:** one shadcn `Card` per item, urgency-colored left border/icon (`urgent`/`high` → destructive-accent token; else neutral), `titleAr`, a facts line (`context` rendered as `key: value` pairs — no free-form HTML, values are strings/numbers only per the Zod schema), `financialImpact` formatted `N.NNN KWD` when present (a small `formatKwd(value: string | null)` constant-driven helper, no magic numbers — "KWD" and the 3-decimal precision come from `01-Data-Model.sql`'s own `char(3) default 'KWD'` / `numeric(14,3)` convention, cited in the code comment), three buttons "اعتماد"/"رفض"/"التفاصيل" (i18n keys) — all three `disabled` (decision 2 above). Sort order client-side: `financialImpact desc nulls last`, then a fixed urgency rank (`urgent` > `high` > `normal` > everything else) — mirrors the DB index `(assigned_role, status, urgency, financial_impact desc)` without needing a live query.
6. **Header bar:** "صندوق القرارات — {role}" + "{n} تحتاج قرارك" (i18n, interpolated), exactly the mockup's top line.
7. **Route:** `/inbox`, and it is also the index route (`/` redirects to `/inbox`) — "the inbox IS the home page" (doc 29 §6-2).
8. **i18n:** six JSON files, flat key namespace `inbox.*` + `emptyState.*` + `nav.*`; every user-facing string goes through a `t(key)` helper (a minimal typed lookup over the `ar` file's key set — no i18n library dependency added for one screen; if a second screen lands before a shared i18n package exists, that's the trigger to add a library, not before). `ar` is authored first and is the fallback for a missing key in another locale (never a blank string).
9. **RTL:** `<html dir="rtl" lang="ar">` by default; a locale switcher (a plain `<select>` in the header, no persistence — no browser storage capability requested for this static shell) toggles `document.dir` between `rtl` (ar, ur) and `ltr` (en, hi, bn, am) and re-renders with the new locale's strings.
10. **No console.log** — use `console.error` is also banned (CLAUDE.md's "no console.log" is read as "no console.* for app logging"); a data-fetch failure (mock client never rejects, but the port signature allows it) renders an inline error state via the same `EmptyState`-adjacent pattern (`missing` = "تعذّر تحميل القرارات", `owner` = "الدعم الفني" as a placeholder) rather than throwing to the console.
11. **No magic numbers:** the fixture item count, KWD decimal places, and the urgency rank order are named constants, not inline literals.

## Scenario (component-level, pg-tester writes as Vitest + Testing Library `describe`/`it` blocks — no `.feature` file for this slice since there is no backend to drive a Gherkin integration test against; recorded as a default)
```
Decision Inbox (apps/admin/tests/decision-inbox/decision-inbox.test.tsx)

- renders the header with the role and the open-item count
- renders one card per open decision, ordered by financialImpact desc then urgency rank
  (assert order using the fixture's known values)
- shows the financial impact formatted as "N.NNN KWD" when present, and omits the line when null
- gives every item exactly three disabled action buttons (اعتماد / رفض / التفاصيل)
- applies the urgency-based accent only to items whose urgency is 'urgent' or 'high'
- given the empty mock client: renders the EmptyState component with the missing-data text and
  an owner value, and renders NO decision cards
- the empty state's two required facts (missing + owner) are both present as visible text
- default route "/" renders the same content as "/inbox" (redirect)
- switching the locale selector to "en" replaces the visible Arabic strings with their English
  i18n counterparts and flips the root dir attribute to "ltr"; switching to "ar" flips it back to "rtl"
- a client that rejects (simulated) renders the inline error EmptyState variant, never throws
  to the console (spy on console.error and assert zero calls)

EmptyState component (apps/admin/tests/decision-inbox/empty-state.test.tsx)
- renders the given title, missing text and owner text, all three visible
```

## Contract (`apps/admin/src/features/decision-inbox/contract.ts`)
`DecisionItemSchema` (Zod) per decision 2 above, `.meta({ id: 'DecisionItem' })`; `z.array(DecisionItemSchema)` as `DecisionListSchema` for the client's return type check (dev-time validation of the mock/future-real payload, matching how every other slice's contract is the single source of shape).

## Deliver
- `apps/admin/package.json, vite.config.ts, tsconfig.json, tsconfig.test.json, tailwind.config.ts, postcss.config.js, index.html`
- `apps/admin/src/{main.tsx, App.tsx, router.tsx, styles/tokens.css}`
- `apps/admin/src/components/empty-state.tsx`
- `apps/admin/src/components/ui/{button.tsx, card.tsx, badge.tsx}` (shadcn primitives, generated/hand-added per shadcn convention — CLAUDE.md's "hand-made tree is a review FAIL" governs *replicated module slices*; this is the first UI tree, nothing to replicate from)
- `apps/admin/src/features/decision-inbox/{contract.ts, client.ts, mock-client.ts, constants.ts, decision-card.tsx, decision-inbox-screen.tsx, index.ts}`
- `apps/admin/src/i18n/{ar,en,hi,ur,bn,am}.json` · `apps/admin/src/i18n/t.ts` (lookup helper)
- `apps/admin/tests/decision-inbox/{decision-inbox.test.tsx, empty-state.test.tsx}`

Migration number: none (UI shell only — confirmed by the Master).
Stop-and-ask if: any table/column/rule not in 01 / 13 / 13B / 019 / 40 — file under G-01; never invent. A need to touch `modules/platform`, `packages/contracts/platform`, or `packages/i18n` (shared) is a lock/frozen-path conflict — STOP and report to the Master, do not widen the lock.
