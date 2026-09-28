# SLICE BRIEF — WBS 4.19 (i18n prerequisite) · `packages/i18n/<lang>/billing.json`, six locales, one key

Task: 4.19 — i18n prerequisite of PR #170 (lane 2)      Lane: M (M-core, ADR-0007)      Lock: `packages/i18n | M | 4.19` (claimed by Master M6, f039d83)
builder: pg-builder-core
Session: M-core (session_01PinCZHwUx6Nm3Mg2Ln8cME), branch `core/4.19-i18n` off main 69f4734. Routing (ADR-0005 §5): pg-tester sonnet (RED) → pg-reviewer opus (brief + RED) → pg-builder-core opus → pg-tester verify → pg-reviewer opus close. Budget ≤ 8 files / 1,000 lines read, ≤ 150k tokens; REVIEW CAP 2 rounds. PR opened by the Master (M6), not by this session.
Merge order: f039d83 (the lock claim) is cherry-picked alone into a lock PR and merged to main first — origin/master-i18n-billing is never merged whole (it carries the rejected f4ede3a); this branch then rebases on main before its PR. The uncommitted `tasks/LANE_LOCKS.md` row in this worktree is never staged here: stage explicit paths, never `git commit -a`.

## Why
`modules/billing/infrastructure/accounting-periods/repository.ts` (lane/2-4.19, PR #170) reads the reopen decision's `title_ar` from `packages/i18n/ar/billing.json` when deps are built, so apps/api boot, the 4.19 tests and G16 fail until the file is on main. `packages/*` is frozen for lanes; an earlier copy was written by a lane builder through Bash around lane-guard (PR #170 review findings) and a Master-direct copy (PR #174, commit f4ede3a) was rejected for authorship — neither is reused. The values come from R5's verified comment (PR #170, issuecomment-5875924622), sha256-pinned.

## Facts
- `packages/i18n/` does not exist on main; `scripts/new-slice.sh:32,216-221` already expects `packages/i18n/<lang>/<module>.json` for ar en hi ur bn am.
- Key: `billing.accountingPeriods.reopenDecision.title` (flat key, the `apps/admin/src/i18n/*.json` convention). Only `ar` is read at run time; the loader does not trim.
- Format: 2-space-indented JSON, UTF-8 without BOM, one trailing newline.

## Decisions (defaults — one CHANGELOG line each)
1. Exactly six files, one key each; no `package.json` for `packages/i18n` (no code imports it as a package; the loader reads the file path). A package manifest, loader or key-set test across modules is a later slice.
2. Byte-equality with R5's sha256 values is the acceptance test (the text itself is R5's, reviewed on #170; this slice does not translate).
3. Files written only through Edit/Write (lane-guard enforced, `packages/i18n` lock); never through a Bash script.

## Read ONLY (workers)
- `CLAUDE.md`
- `.claude/briefs/billing.brief.md`
- `scripts/new-slice.sh` lines 20-40, 205-225
- `tests/ops/tests/x-part-6.test.ts` lines 1-60 (repo-shape test idiom)
- `tests/ops/package.json`
- `apps/admin/src/i18n/en.json` lines 1-10 (flat-key convention)

Write ONLY: `packages/i18n/{ar,en,hi,ur,bn,am}/billing.json` (pg-builder-core) · `tests/ops/tests/i18n-billing.test.ts` + `tests/ops/i18n-billing.feature` (pg-tester only). Never CLAUDE.md, `.claude/*`, `apps/*`, `modules/*`, `tasks/LANE_LOCKS.md`.
Contract: none. Screen/Board spec: none. Migration number: none.

## RED tests
`tests/ops/i18n-billing.feature` · `tests/ops/tests/i18n-billing.test.ts` — run `pnpm test:ops` (or `cd tests/ops && pnpm exec vitest run tests/i18n-billing.test.ts`).

```gherkin
Feature: billing i18n files for the reopen decision title (WBS 4.19 prerequisite)
  Scenario: Each of the six locales has packages/i18n/<lang>/billing.json
  Scenario: Every file holds exactly the key billing.accountingPeriods.reopenDecision.title with a non-empty string value
  Scenario: Every file is byte-identical to the sha256 R5 published on PR #170
  Scenario: Every file is 2-space JSON, UTF-8 without BOM, ending in exactly one newline
```

sha256 (R5, PR #170 issuecomment-5875924622):
```
856284e748f82660a7a1df266bc5543c33d123c42952a66d874261c186e96d56  ar
d190e63fca9887b7a7e2bda67cd18a40babe92b6915857f2db0b4c423a982653  en
16d6224796cbce3c0a03998453d6ee9405da48458ebf12788c8b634eb8be3a8a  hi
7f67fe1ae8ab82c7b99740e0bbd98ff7c134b57e95cc9767ef6c6bc9c6b9e66f  ur
29dff9772f38a5ec61a320a659be300a34cc7c39339ad51bda834202aa8c0645  bn
d7cb8ca9baef7e3d908a14abe40ce51e3139ff207d6405b20bd4f6c9cd3bcf42  am
```
Values (R5): ar «طلب إعادة فتح فترة محاسبية» · en "Request to reopen an accounting period" · hi «लेखा अवधि को फिर से खोलने का अनुरोध» · ur «اکاؤنٹنگ مدت دوبارہ کھولنے کی درخواست» · bn «হিসাবকাল পুনরায় খোলার অনুরোধ» · am «የሂሳብ ጊዜን እንደገና ለመክፈት የቀረበ ጥያቄ».

Deliver: the six files + the two RED files green; `pnpm test:ops` green; `pnpm check:locks`.
Close: one commit `feat(4.19): packages/i18n billing.json — reopen decision title, six locales`, trailers Model/Delegated/Review: PASS(<n> findings, <r> rounds); CHANGELOG entry ≤ 12 lines recording decisions 1–3; the 4.19 row in doc 38 / MASTER_BACKLOG is NOT changed (lane 2 owns it); this brief is deleted in the same commit.
Stop-and-ask if: a hash cannot be matched by the stated format and values (never alter a value to fit a hash — report).
