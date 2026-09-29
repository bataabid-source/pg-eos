# Handover — Advisory (GM directive 2026-09-29 09:35Z, ADR-0007, D-202)

Read after any context summarization, alongside issue #207. The Master updates this file when a GM decision or directive lands on #207. No secrets, no costs.

1. **Role** Advisory session, permanent until production (D-202): no context ceiling, hourly watchdog + daily GM report, creates the Master successor at each rotation. Channel: GitHub issue #207 (one comment per directive `[GM directive <UTC>] <verbatim> — <instruction>`; the Master 👍 once applied).
2. **Standing GM directives (verbatim)**
   - «افوضك بفرض افضل الممارسات الإنتاجية والتقنيه» — delegation: Advisory sets GM-question defaults (DEFAULT, RECORD, PROCEED; the GM overrides on #207).
   - «طبق اليه لتنبيهك اليا لعدم اهدار الوقت لتحسين اداره الجلسات» — automatic waste alerts on sessions.
   - D-197 «موافق علي القرارت» (rebase auto-merge) · D-198 «موافق: (أ) Stryker خارج الفحص المحلي، يبقى في CI والليلي (ب) أرشفة تلقائية (ج) الحد 6 الآن و7 بعد تقييم 30 سبتمبر» · D-200 «إذا كان ممكن العمل المتوازي للجلسات طبقه علي كل المستويات» · D-201 «موافق» 05:45Z (no inline reads/reviews by the Master; fixes on the same PR) · D-202 «موافق» 06:45Z (this role).
   - «نعم» 08:52Z (cap 6 in CLAUDE.md now) — refused twice as [Self-Modification]; dropped by default (Advisory 10:22Z); the GM may edit CLAUDE.md directly.
   - «مقبول نفذ بنفسك» 09:05Z (route-table) · «موافق» 09:35Z (this file).
   - D-203 «١٢» 11:40Z: `identity.session.lifetime_minutes` = 720 (one warehouse shift on a shared PDA; PIN lock 2.16 covers the unattended device); migration 0045 issued to lane 3 (X part 5d part 2, #175).
   - Defaults 12:25Z: (a) 2.9 part 3 takes the whole `wms` lock (lane 1) · (b) SCR-WMS-BATCH-EXPIRY-01 = SCR-WMS-EXPIRY-01 (no table/column) — closed by D-204 · (c) S1 QRT routing + `quarantine_decision` owned by 2.9 part 3 · (d) D-203 = 720 · (e) seven sessions: no change until the Phase-2 evaluation (2026-09-30 08:00Z).
   - D-204 «نعم» 13:25Z (relayed 13:50Z): SCR-WMS-BATCH-EXPIRY-01 option 1 — one expiry per batch across all locations, enforced by 2.9 part 3 in the ledger write path, no schema change; the SCR closes.
   - "[GM directive 2026-09-29 17:30Z] «افتح موجزات خط 1 وقفل wms اليوم»" — lock `pda | 1 | 2.16` → `wms | 1 | 2.9` today; 2.9 part 3 brief (D-204) + 2.16 part 3 brief landed in one chore(X) PR with Override: GM (#215 folded in).
   - "[GM directive 2026-09-29 17:50Z] «موافق»" (relayed 17:38Z — directive time later than the post time, recorded as relayed) — row `2.16 part 2e` PDA visual layer (doc 40 §D4 L420-423: shadcn/Tailwind, ≥ 48 px targets, one step per screen, autofocus scan field, sound + vibration + next action, RTL/LTR, six locales, no logic change), right after 2.16 part 3, before any real-user demo.
3. **Weekly goal** S1 + S2 + S18 via 2.16 + 2.18 (GM 07:20Z). Lane 1 (GM 17:30Z, 17:50Z): 2.9 part 3 now (`wms | 1 | 2.9`) → 2.16 part 3 → 2.16 part 2e (`pda`, re-claimed when 2.9 part 3 closes); 2.16 part 2 merged (#211, 66cfccc). Lane 2: 4.20 (billing, 0041). Integration: X part 5d part 2 (#175, 0045), then 2.18. M-core: X part 16 (#209) → X part 5 → X part 17 → X part 18.
4. **Harness limits**
   - CLAUDE.md is edited only by the GM (refused to the Master as [Self-Modification]).
   - Lane `pnpm add` is refused ([Modify Shared Resources]) — a human approval inside that lane's session, or M-core under `tooling`; the Master never installs for a lane.
   - Cross-session triggers are refused — use #207. Advisory's creation of an M-core successor was refused; the GM starts it from the paste text.
   - No force-push (fix forward, `git merge origin/main`); routine-prompt memory is refused; some "CI bypass"-flagged edits need a GM approval pasted into the session.
5. **Live sessions** Master M12 session_01GmtMXJuTWmqDjZXWYq4jrT · Advisory session_01FfooFQhb5x64sTXDUKu7tP · lane 1 session_01VComj7TLSZGmgfAUrRbGsP (2.9 part 3) · M-core session_011PL2MhC8UPwG79YDwDqjAK (over ceiling) · integration session_014KgrtfNdrtkkD5ZYQWSge7 · lane 2 session_012audWizm1uuLmQZBJd1nLy (4.20).
6. **Open for the GM** Phase-2 evaluation (seven sessions, 2026-09-30 08:00Z) · cap-six CLAUDE.md line · M-core successor start.
