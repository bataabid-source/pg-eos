# GM decision sheet 3 — 2026-09-24 (open decisions after WBS 2.9 and 0.6a)

Source: `docs/notes/SCR-PLAT-IDEM-01-idempotency-key-store.md`, `docs/notes/SCR-WMS-INB-01-receive-inbound-rules.md`, D-142 (0.6a branch protection), pg-reviewer golden-slice review (open question on concurrent PDA scanners), PROJECT_STATE blockers. Written under D-146 (one questionnaire, no question-by-question chat).
★ = the recommendation already written in the source document. A question with no ★ has no written recommendation; nothing is invented. Answer format: `Q1: أ · Q2: أ · …`. Each answer becomes one D-number in `docs/DECISION_LOG.md` and is applied by the Master.

Why these matter now: WBS 2.9 (golden slice, commit `eef0d42`, CI fix `83f984c`) is built and passed its review (4 rounds, 36 findings fixed), but it is **NOT DONE**: `.golden-slice-accepted` cannot be created — and no lane can open — until Q1–Q7 are answered and Q10 is given. 0.6a closes on Q8.

---

## أ) الشريحة الذهبية 2.9 — طلبات تغيير المخطط

| # | القرار | الخيارات | المرجع |
|---|---|---|---|
| **Q1** | مخزن مفاتيح Idempotency-Key (رفض 409 عند إعادة استعمال المفتاح بجسم مختلف، وإعادة النتيجة السابقة) | أ) ★ اعتماد جدول `platform.idempotency_keys` كما في الطلب، مشترك لكل الوحدات · ب) في مخطط آخر (يُكتب) · ج) يُؤجَّل بعد الـpilot وتُقبل 2.9 بفحص وجود المفتاح فقط | SCR-PLAT-IDEM-01 · doc 40 §A4 |
| **Q2** | مدة الاحتفاظ بالمفاتيح | أ) ★ 7 أيام (doc 40 §A4) · ب) قيمة أخرى (تُكتب) | SCR-PLAT-IDEM-01 §2 |
| **Q3** | أمر وارد كل سطوره استُلمت بكمية صفر: إغلاقه مباشرة من `received` | أ) ★ إبقاء الانتقال (المبني الآن) · ب) لا إغلاق؛ يُلغى الأمر بدلاً منه | SCR-WMS-INB-01 §1 |
| **Q4** | سطر استُلم بكمية صفر مع سبب فرق | أ) ★ يكتمل دون تخزين ولا يُكتب في الدفتر (المبني الآن) · ب) أمر مستقل لإلغاء السطر | SCR-WMS-INB-01 §2 |
| **Q5** | أمرا الإغلاق والإلغاء وصلاحياتهما | أ) ★ اعتماد: الإغلاق لـ WH_SUP، والإلغاء لـ WH_MGR ويُرفض بعد أي استلام (المبني الآن) · ب) صلاحيات أخرى (تُكتب) | SCR-WMS-INB-01 §3 |
| **Q6** | صورة الفرق عند الاستلام — لا عمود لها | أ) ★ إضافة `variance_photo_url` و`variance_photo_sha256` إلى `wms.order_lines` (والرفع يأتي مع شاشة PDA) · ب) تبقى خارج الـpilot (D-127) | SCR-WMS-INB-01 §4 |

## ب) المراقبة والتشغيل

| # | القرار | الخيارات | المرجع |
|---|---|---|---|
| **Q7** | المراقبة (سجل خادم منظم + لوحة) — بند المراجعة 36 §5-4 #10 | أ) إضافة pino الآن كتبعية وسجل منظم في الشريحة الذهبية، واللوحة لاحقاً · ب) يُؤجَّل كله بعد الـpilot وتُقبل 2.9 بدونه | CLAUDE.md (No console.log — pino) · 36 §5-4 #10 |
| **Q8** | حماية فرع main (قررتَ الحماية مع PR في D-142، وGitHub لا يفرضها على مستودع خاص بالخطة المجانية) | أ) ترقية الحساب إلى GitHub Pro (تشتريها أنت، نحو 4$ شهرياً) ثم أطبّق القاعدة · ب) جعل المستودع عاماً (الكود يصبح مكشوفاً) · ج) قاعدة عمل بلا فرض: كل مهمة PR ولا دمج قبل CI أخضر | D-142 · 0.6a |
| **Q9** | عدة أجهزة PDA تستلم الأمر نفسه في آن واحد فيحصل بعضها على 409 | أ) ★ قبول: الجهاز يعيد قراءة الأمر ويعيد المحاولة تلقائياً عند 409 (doc 40 §A4) · ب) تغيير التصميم إلى رقم إصدار لكل سطر بدل الأمر كله | مراجعة الشريحة الذهبية، سؤال مفتوح |

## ج) قبول الشريحة الذهبية

| # | القرار | الخيارات | المرجع |
|---|---|---|---|
| **Q10** | مراجعتك الشخصية لـ 2.9 (شرط CLAUDE.md: "Built once with full human review") | أ) راجعتُها وأقبلها بعد تطبيق Q1–Q9: يُنشأ `.golden-slice-accepted` ويُفعَّل `new-slice.sh` · ب) أرسل لي ملخص مراجعة (الملفات، آلة الحالة، القرارات) قبل القبول · ج) لا تُقبل بعد (اكتب السبب) | CLAUDE.md GOLDEN SLICE · EXECUTION-MASTER-v4 §3.5 |

Where to review 2.9: `modules/wms/{domain,application,infrastructure,api,tests}/receive-inbound/` and `packages/contracts/wms/receive-inbound.ts`; the state machine is `modules/wms/domain/receive-inbound/machine.ts`; the Master defaults are listed in `docs/CHANGELOG.md` under "## 2.9".
