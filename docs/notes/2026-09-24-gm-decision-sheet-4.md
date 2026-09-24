# GM decision sheet 4 — 2026-09-24 (golden slice 2.9: the two decisions left before acceptance)

Source: the GM's answer Q10 ب on sheet 3 (D-159, "send me a review summary before acceptance"); `docs/notes/SCR-WMS-INB-01-receive-inbound-rules.md` §6. Interactive copy with the full review summary: https://claude.ai/artifact/TweQHGq5M58kiuuYKdsmfQ (private). Written under D-146. Answer format: `R1: أ · R2: أ`. Each answer becomes one D-number.

State at writing: 2.9 built and reviewed — part 1 `eef0d42` (golden-slice review FAIL(21) → FAIL(13) → FAIL(2) → PASS), part 2 `efd52f4` (FAIL(8) → FAIL(2) → PASS); 46 findings fixed; wms 261/261, db 24/24, platform 27/27, logger 3/3 as `pgeos_app`; guards G1–G14, G18, G-SEED green. `.golden-slice-accepted` not created.

| # | القرار | الخيارات | المرجع |
|---|---|---|---|
| **R1** | أمر كل سطوره استُلمت بكمية صفر: يصدر له GRN وحدث فوترة عند اكتمال الاستلام، ثم يُلغى | أ) يبقى كما بُني — حدث الفوترة يبقى قائماً بعد الإلغاء (لا يوجد حدث إلغاء يعكسه؛ إلغاؤه يحتاج حدثاً جديداً تعتمده باسمه) · ب) لا GRN ولا حدث فوترة حين تكون كل السطور صفراً (تعديل صغير في `receive-line.ts` ثم مراجعة) | SCR-WMS-INB-01 §6 — يمنع القبول |
| **R2** | قبول الشريحة الذهبية (يُنشئ `.golden-slice-accepted`، يُفعَّل `new-slice.sh`، تُفتح المسارات) | أ) أقبلها بعد تطبيق R1 · ب) لا أقبلها بعد (يُكتب السبب أو المطلوب تغييره) | CLAUDE.md GOLDEN SLICE · EXECUTION-MASTER-v4 §3.5 |

Where to review the code yourself: `modules/wms/domain/receive-inbound/machine.ts` (state machine), `modules/wms/application/receive-inbound/` (commands), `modules/wms/infrastructure/receive-inbound/repository.ts` (all SQL and the lock order), `modules/wms/tests/receive-inbound/receive-inbound.feature` (scenarios), `docs/CHANGELOG.md` under "2.9" (every default).
