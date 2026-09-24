# GM decision sheet 5 — 2026-09-24 (everything still waiting for the GM after the golden slice)

Interactive checklist (answer there, copy the line): https://claude.ai/artifact/Giy43tqz5q1vYJBJ4TJVjH
Written on the GM's request ("افتح استبيان للإجابات المطلوبة … مع أي أمور أخرى عالقة تنتظر فيها البت مني"). ★ = the Master's recommendation; proposed numbers are professional judgement, not system numbers. Answer format `Q1: أ · Q2: ب (2%) …`; each answer becomes one D-number.

## أ) Left over from sheet 2 (D-141)
| # | Question | Options |
|---|---|---|
| Q1 | Space-contract model vs ST-14 / quote reservations | أ ★ GM model governs: fixed contract billed on contracted qty (ST-14 unused), variable on occupancy, reservations only from signed contracts; add `sales.contracts.space_model` + `billing_period` · ب hybrid (variable contracts also bill ST-14 on reserved-unused when the contract says so) · ج revert to the package |
| Q2 | One-time commission at signature (Q7a) — value | أ ★ % of expected first-year contract value (typical 1–3%, GM writes) · ب fixed amount per segment · ج one month of contract revenue |
| Q3 | Commission matrix segment × category (Q7b) | أ ★ base rates (ST 3 · HD/OF/VA 5 · DL 2 · CC 3) with 75% for SEG-A/B, 0 for SEG-F · ب base rates flat · ج GM writes the matrix |
| Q4 | Monthly cap multiplier (Q7e) | أ ★ 2× salary · ب 1× · ج 3× · د other |
| Q5 | Structural-engineer date typo | أ 20/8/2025 · ب 22/8/2025 · ج other |
| Q6 | Probation confirmation criterion at day 90 | أ ★ supervisor 5-item form avg ≥ 3.5 + attendance ≥ 95% + no grade-2 penalty · ب supervisor yes/no with reason · ج attendance & penalties only |
| Q7 | The seven cancelled policy controls (Q42) | أ ★ delete the five company-policy ones now, keep grievance-7-days and clearance-after-housing until counsel · ب nothing until counsel reviews all seven · ج delete all seven now |

## ب) Delivery-client portal (SCR-TMS-PORTAL-01, D-160/D-163)
| Q8 | Approve the SCR (18 screens) | أ ★ approve · ب approve with change · ج defer |
| Q9 | Who may dispatch in the client account | أ ★ CLIENT_ADMIN + CLIENT_CREATOR · ب CLIENT_ADMIN only |
| Q10 | Driver-position retention | أ ★ 30 days · ب 90 · ج 7 |
| Q11 | Position ping while moving | أ ★ 60 s · ب 30 s · ج 120 s |

## ج) iMile (D-147…D-149)
| Q12 | Portal operations check (bulk / single form / unavailable per scan type) | أ ★ DEL_MGR + SYSADMIN this week (date) · ب GM + SYSADMIN (date) · ج defer to Phase 3 start |
| Q13 | Under which iMile user are engine auto-decisions pushed | أ ★ the team auditor's session, recorded as engine internally · ب a dedicated "system" iMile account (needs iMile consent) · ج no auto push, auditor clicks execute |
| Q14 | Warehouse export cadence | أ ★ 60-second micro-batches, real-time only where iMile requires · ب 5 minutes · ج per-scan real-time where the portal allows |

## د) Other open items
| Q15 | APP-1 WBS id now that shifts/sites are in the pilot | أ ★ issue 5.3b, lane 2 with shifts · ب build inside 5.3 · ج stays post-pilot |
| Q16 | Payroll SCR timing | أ ★ post-pilot · ب now, inside the pilot |
| Q17 | Which alerts sound by default on operational web boards | أ ★ the realtime seven (N-01, N-03, N-10, N-13, N-14, N-19, N-22) · ب every alert of operational roles · ج GM list |
| Q18 | Lane allocation once blockers (a)(b)(c) are closed | أ ★ lane 1: 1.2 → 3.1 · lane 2: 3.3 → D-144 shifts/sites · lane 3: 5.13 → 3.14 after the portal check · ب lane 3 waits for the check to start with 3.14 · ج two lanes only |
| Q19 | GitHub identity step (repo public, D-157) | أ done · ب later (0.6a stays open) |

Not listed (no GM decision needed): blockers (a)(b)(c) before lanes are build tasks for the build session; reference-data seeding (column classification, permissions, min prices, chart of accounts) is data entry with CFO/SYSADMIN, tracked in Gap-Register #1/#3/#4/#78.

---

## Answers — GM 2026-09-24, recorded as D-165

> Q1: أ · Q2: ج (كل إعدادات العمولات اجعلها مدخلات يتم إعدادها لاحقاً من إعدادات النظام مع تقديم مثال للأثر للتوضيح) · Q3: ج (نفس النص) · Q4: د (نفس النص) · Q5: ج (احذف هذا البند من المشروع أو اعزله لأحذفه أنا) · Q6: أ · Q7: ج · Q8: أ · Q9: أ · Q10: أ · Q11: ب · Q12: ب (متاح طول الوقت) · Q13: أ · Q14: أ · Q15: أ · Q16: أ · Q17: ب · Q18: أ · Q19: أ

Applied per D-165 in `docs/DECISION_LOG.md`. Q2–Q4: commission is configuration with a worked-example preview; Q5 isolated for the GM; Q7 all seven deleted; Q15 APP-1 = 5.3b.
