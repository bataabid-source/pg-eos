# GM decision sheet 2 — 2026-09-24 (all open GM items as multiple choice)

Source: `docs/package/D-blueprints/09-Gap-Register.md` (every ⏳ row), D-11 §4, D-12 §10-3, D-13 §8, D-14 §8, D-15 §8-2 (D-2…D-6), SCR-HR-ATT-01 §6 carried items, SCR-TMS-PICKUP-01 §7 item 3, ADR-0002 G8 anchor, CHANGELOG 2.3 batched questions, PROJECT_STATE blockers. Written on the GM's request of 2026-09-24 ("اسرد كل النقاط … على شكل تحديد إجابة من ضمن خيارات").
★ = the recommendation already written in the source document. A question with no ★ has no written recommendation; nothing is invented. Answer format: `Q1: ب · Q2: أ · …`. Each answer becomes one D-number in `docs/DECISION_LOG.md` and is applied by the Master; nothing here changes the pilot path (D-127) unless the answer says "now".

---

## أ) التجاري والتسعير

| # | القرار | الخيارات | المرجع |
|---|---|---|---|
| **Q1** | أساس السعر التحويلي بين الكيانات (PCC → المجموعة، PDL ↔ PST) | أ) بالتكلفة الفعلية · ب) التكلفة + هامش (تكتب النسبة) · ج) سعر السوق (قائمة الشريحة) · د) يُؤجَّل بعد الـpilot | Gap #8 · bp-02 §13-1-1 |
| **Q2** | الحد الأدنى لهامش الخدمة المعاد بيعها من شريك | أ) حارس صلب على كل سطر: تحذير < 15% ورفض < 10% إلا بموافقة GM · ب) تحذير فقط بلا رفض · ج) لا حارس (الوضع الحالي: يُكتشف بعد وقوعه) | Gap #9 |
| **Q3** | من يطابق فاتورة الشريك ومن يعتمدها | أ) ACCOUNTANT يطابق · CFO يعتمد · ب) مالك العملية (WH_MGR/DEL_MGR) يطابق · CFO يعتمد · ج) ACCOUNTANT يطابق · GM يعتمد | Gap #10 |
| **Q4** | مصدر فوترة ST-14 (المحجوز غير المستخدم) | أ) ★ `wms.space_reservations` كما في 17 §7 · ب) المتعاقد − المشغول · ج) لا فوترة آلية حتى قرار CFO | Gap #72 · D-13 §8-3 |
| **Q5** | وحدة بيع الأرفف وخريطة نوع الكتلة → خدمة ST | أ) بالموضع، والخريطة الافتراضية: `pallet_rack→ST-01 · shelf/mezzanine→ST-04 · floor→ST-02 · yard→ST-10 · cold→ST-05 · frozen→ST-06 · secure→ST-09 · hazmat→ST-08` تُبذر ويعدّلها CFO · ب) بالمتر المربع · ج) بالمتر المكعب | Gap #74 · D-13 §8-7/8-8 |
| **Q6** | ست خدمات تخزين لا يوفّرها WH1 (ST-05…ST-10) | أ) تُباع عبر شريك (doc 09) · ب) تُحذف من الكتالوج (92 → 86، قرار GM + CFO) · ج) تبقى ويُرفض كل طلب حتى وجود شريك (الوضع الحالي S9) | Gap #45 · D-13 §8-10 |
| **Q7** | نموذج عمولة المبيعات (8 بنود، كلها لها توصية) — أجب "اعتماد الثماني" أو بنداً بنداً | **Q7a** النموذج: أ راتب فقط · ب ★ متكررة · ج مرة واحدة · د مختلط **· Q7b** النسب: أ ★ ST 3% · خدمات 5% · DL 2% · CC 3% لسنة أولى · ب نسب أخرى (تُكتب) **· Q7c** الأساس: أ ★ محصَّل · ب مفوتر **· Q7d** المدة: أ بلا نهاية · ب ★ 24 شهراً · ج 12 شهراً · د حتى نهاية العقد الأول **· Q7e** السقف: أ ★ بلا سقف السنة الأولى مع مراجعة من تجاوزت عمولته راتبه · ب سقف بالدينار · ج مضاعف من الراتب **· Q7f** نسبة مدير المبيعات: أ لا شيء · ب ★ 0.5% من المحصَّل للفريق · ج نسبة من عمولات الفريق **· Q7g** العملاء الحاليون: أ لا عمولة · ب كاملة · ج ★ نصف النسبة 12 شهراً لمالك الحساب يوم التفعيل · د لمن جلبهم فعلاً **· Q7h** اعتماد SCR-SC-01: أ ★ اعتماد · ب تعديل · ج رفض | Gap #75 · D-14 §8 |
| **Q8** | كود خدمة الاستلام من موقع العميل (pickup) | أ) ضمن DL-01/DL-02 بلا تغيير في الكتالوج (الافتراضي القائم) · ب) خدمة جديدة DL-19 (يلزم CFO: `min_price` و`standard_cost`) | SCR-TMS-PICKUP-01 §7-3 |

## ب) العمليات — المستودع

| # | القرار | الخيارات | المرجع |
|---|---|---|---|
| **Q9** | العتبات السبع `wo.*` (3 مهام نشطة · 60/30/30/120/240/480 دقيقة) | أ) تُعتمد مؤقتاً وتُضبط بعد أول شهر قياس · ب) قيم أخرى الآن (تُكتب) | Gap #66 · D-12 §10-3 D-1 |
| **Q10** | مكافأة إنتاجية لعمال المستودع | أ) لا مكافأة الآن · ب) قاعدة `applies_to='warehouse'` بمعدل لكل مهمة (تكتب المعدل) · ج) بمعدل لكل سطر (تكتب المعدل) | Gap #67 · D-12 D-2 |
| **Q11** | أكواد استثناء مهام المستودع | أ) اعتماد الستة المقترحة (`not_found · short_qty · damaged · blocked_location · wrong_client · equipment_down`) · ب) جدول مرجعي نظير `tms.failure_reasons` يملؤه WH_MGR · ج) نص حر مع كود (الوضع الحالي) | Gap #70 · D-12 W-5 |
| **Q12** | ساعات الدوام (تحدد رسوم "خارج الدوام" HD-13 وDL-09) | أ) مفتاح `ops.working_hours` في `platform.settings` (تكتب الأيام والساعات) فتُحتسب آلياً · ب) تبقى يدوية | Gap #71 · D-12 W-6 |
| **Q13** | فوترة أوامر العمل الكبيرة | أ) عند `completed` فقط (القرار الحالي) · ب) أوامر يومية للعملاء الذين يطلبون فوترة يومية | D-12 D-4 (GM + CFO) |
| **Q14** | تجاوز حد المهام النشطة للعامل | أ) الحد صلب · ب) WH_SUP يتجاوزه بسبب مسجَّل | D-12 D-5 |
| **Q15** | تأكيد مهندس إنشائي أن اعتماد البلاطة على 2,439.75 طن (لا 1,420.5) | أ) تم — أرفق المرجع · ب) لم يتم بعد (الحدود المبذورة تبقى 1,000/750 كجم) | Gap #34 — توقيع خارجي |

## ج) التوصيل · iMile · التكامل · اللوحات

| # | القرار | الخيارات | المرجع |
|---|---|---|---|
| **Q16** | معتمِد إعادة تخصيص معرّف iMile (والمسنِد ≠ المعتمِد) | أ) DEL_MGR يعتمد (مالك D10) · ب) GM يعتمد | Gap #39 |
| **Q17** | حالات `integration_queue` | أ) القاعدة هي الحاكمة (`pending · processing · done · failed`) ويُصحَّح doc 23 · ب) الوثيقة هي الحاكمة (`pending · resolved · discarded`) وتُكتب migration | Gap #58 · D-11 CSI-08 |
| **Q18** | مسار استيراد الطلبات من ملف (doc 05 S3 يعد به) | أ) مهمة WBS جديدة في المرحلة 3 بعد 3.4 (الخيار ب في D-11) · ب) في المرحلة 2 بعد 2.11 · ج) لا — API فقط في المرحلة 6 | Gap #59 |
| **Q19** | موصّلات منصات المتاجر (Salla · Zid · Shopify · WooCommerce) | أ) تُنشأ I-12 كمهمة `6.2b` في المرحلة 6 · ب) تُقدَّم إلى المرحلة 3 · ج) لا موصّلات — "نوفّر API والعميل يبرمج" | Gap #60 · D-11 §4-4 |
| **Q20** | لغات بطاقة اللوحة | أ) ست لغات في كل مكان · ب) ★ ست في التطبيقات الميدانية، عربي/إنجليزي في لوحة الإدارة · ج) عربي فقط | D-15 D-2 |
| **Q21** | صندوق القرارات واللوحة | أ) ★ `/inbox` يصير اللوحة والقرارات مجموعة فيها · ب) لوحتان منفصلتان | D-15 D-3 |
| **Q22** | هدف "≤ 3 نقرات حتى الإنجاز" | أ) ★ يُعتمد مع استثناء المسح/POD (≤ 6 نقرات) · ب) لبنود القرار فقط · ج) بلا رقم | D-15 D-4 |
| **Q23** | عتبتا "≤ 7 بنود للدور" و"وسيط بتّ ≤ 4 ساعات" | أ) تعميم كما هما · ب) ★ عتبة لكل مجموعة تُضبط بعد شهر قياس · ج) للقرارات فقط | D-15 D-5 |
| **Q24** | ما يراه المشرف من مهام عمّاله في لوحته | أ) كلها · ب) ★ المتأخر والمتعثّر والطابور بلا عامل فقط · ج) شاشة منفصلة | D-15 D-6 |

## د) الموارد البشرية · القانوني · الحضور

| # | القرار | الخيارات | المرجع |
|---|---|---|---|
| **Q25** | سقف مجموع الاستقطاعات الشهرية من الأجر | أ) 25% مؤقتاً حتى رأي المستشار · ب) قيمة أخرى من المستشار (تُكتب) · ج) لا يُفرض حتى الرأي القانوني | Gap #12 · bp-06 GM-1 |
| **Q26** | فترة التجربة ومعايير التثبيت | أ) عدد الأيام (يُكتب) + معيار التثبيت (يُكتب) · ب) بعد مراجعة المستشار القانوني | Gap #40 · GM-2 |
| **Q27** | معالجة تكلفة الاستقدام محاسبياً | أ) إطفاء على مدة العقد (EXEC §1.3) · ب) تحميل دفعة واحدة | Gap #41 · GM-3 |
| **Q28** | غرامات العملاء لسائقي العمولة | أ) تخفيض لقاعدة العمولة (المعتمد اليوم، خارج سقف م.38) · ب) خصم من الأجر تحت سقف م.38 — بعد تأكيد المستشار | Gap #42 · GM-5 |
| **Q29** | اعتماد الهيئة العامة للقوى العاملة للائحة الجزاءات (م.36) ونسخة موقَّعة لكل موظف (م.35) | أ) تم — التاريخ · ب) لم يتم (الشارة التحذيرية تبقى على كل جزاء) | Gap #13 · GM-6 — توقيع خارجي |
| **Q30** | الحضور البيومتري — البنود المرحَّلة من SCR-HR-ATT-01 (كلها بعد الـpilot) | **Q30a** حامل النطاق الجغرافي: أ نصف قطر على الموقع (`sites.geo + radius_m`) · ب جدول مضلّعات **· Q30b** نصف القطر بالمتر (يُكتب) **· Q30c** مدة الاحتفاظ بسجل البصمة (تُكتب بالأشهر) **· Q30d** معتمِد إعادة تسجيل جهاز السائق: أ HR_MGR · ب DEL_MGR · ج GM **· Q30e** البصمة خارج النطاق/بلا اتصال/جهاز غير مسجَّل: أ كلها إلى طابور مراجعة HR · ب قبول آلي لبلا-اتصال داخل النطاق، والباقي للمراجعة **· Q30f** هوية الـPDA المشترك: أ PIN لكل عامل على الجهاز · ب يبقى مسار الـPDA محجوباً للحضور **· Q30g** تصنيف أعمدة GPS: أ `personal` · ب `secret` | SCR-HR-ATT-01 §6 · ADR-0003 items 1/3/4a/5/8/9/10 |

## هـ) الحوكمة والمنصة

| # | القرار | الخيارات | المرجع |
|---|---|---|---|
| **Q31** | مالك المجالات D03 · D04 · D05 · D11 (تعارض داخل doc 22) | أ) CFO (المبذور، يتسق مع زوج SoD) · ب) SALES_MGR | Gap #35 |
| **Q32** | العمليات الحكمية: تسع بمستوى A1، و"رفع الحجز الائتماني" A1 | أ) إقرار المبذور (تسع · A1) · ب) رفع الحجز الائتماني A0 (يحتاج موافقة ثانية) | Gap #36 |
| **Q33** | "مدير القسم الطالب" في سلاسل الاعتماد (`approver_role` مفرد) | أ) إقرار WH_MGR المبذور كقيمة قابلة للاستبدال · ب) اشتقاق المعتمِد من قسم الطلب (تغيير مخطط G-01) | Gap #37 |
| **Q34** | سلسلة ترقيم مستندات `platform.documents` | أ) إقرار `DOC` (`DC`) المبذورة · ب) سلسلة أخرى (تُكتب) | Gap #38 |
| **Q35** | شاغل `DEPUTY_SYSADMIN` قبل المرحلة 4 | أ) الاسم (يُكتب) · ب) لاحقاً — CFO يبقى المعتمِد الثاني | Gap #43 · GM-7 — توقيع |
| **Q36** | مالك بالاسم لكل مجال من الاثني عشر | أ) الآن (تُكتب الأسماء) · ب) في المرحلة 7 قبل الإطلاق | Gap #44 · GM-8 |
| **Q37** | مرساة سلسلة التدقيق G8 بعد أول فصل قسم (≥ 2028-03) | أ) ★ مفتاح في `platform.settings` يكتبه job الأرشفة · ب) بيان الأرشيف فقط وG8 بمعاملات · ج) جدول جديد | ADR-0002 · D-115 |
| **Q38** | الخارجي: C-05 الفوترة الضريبية · C-07 خروج البيانات من الكويت · طلب API الرسمي من iMile (X.6) | لكل واحد: أ) تم · ب) قيد الإجراء · ج) لم يبدأ | Gap #46 |
| **Q39** | ماسح الأسرار في CI (0.6a، البوابة ⑥) | أ) gitleaks · ب) trufflehog · ج) GitHub secret scanning فقط | CHANGELOG 2.3 (b) |
| **Q40** | صياغة صف 0.8 في doc 38 (ما زال "OCI + dep 0.5") | أ) تُعاد كتابته على Docker المحلي (D-130) وتبقى OCI مع 0.5 · ب) يبقى كما هو | PROJECT_STATE blockers |
| **Q41** | المبدأ P3: `REVOKE UPDATE, DELETE` على الدفاتر المالية | أ) مع دور `pgeos_app` في 0.6a الآن · ب) مهمة منفصلة بعد الـpilot | Gap #14 |
| **Q42** | سبعة ضوابط سياسية بلا فرض تقني (تظلّم 7 أيام · اعتراض عمولة 48 ساعة · تسوية عهدة 70% · فصل رباعي مشتريات · إخلاء طرف بعد إخلاء سكن · رفض فاتورة بلا أمر شراء…) | أ) تُفرض في المخطط بطلب G-01 واحد بعد الـpilot · ب) تبقى سياسة يدوية | Gap #25 |
| **Q43** | القوائم المغلقة الناقصة (`cost_type/basis` · `count_type` · `order_type` · `disposition` · `event_type` · `channel` · `txn_type` · `direction` · `grievance_outcome`) | أ) يزوّد كل مالك مجال قائمته بعد الـpilot وتُفرض بقيود · ب) تبقى نصاً حراً | Gap #15/#22/#23/#24 |

---

Items deliberately **not** listed (they are WBS data tasks or seeds, not GM choices): Gap #1 column classification (G6), #3 chart of accounts (M07), #4 min_price/standard_cost (M03), #5 30-day cap test, #7/#17 payroll-shifts-leaves (design work, needs its own SCR after the pilot), #18 device registry (in SCR-HR-ATT-01), #77 `driver_id` FK, #78 permissions seed, D-13 §8-6 `monthly_cost` per block (CFO data gate).

---

## Answers — GM 2026-09-24, recorded as D-139 (verbatim, then how each is applied)

The GM answered on the interactive sheet (v2, plain-language wording with a ✕ "cancel the process" option). Verbatim answer line:

> Q1: ب (20%) · Q2: أ · Q3: ب · Q4: — · Q5: أ · Q6: أ · Q7a: ج · Q7b: ب (تحدد علي حسب كل شريحه من شرائح العملاء والاسعار والخدمات) · Q7c: أ · Q7d: أ · Q7e: ج · Q7f: ب · Q7g: أ · Q7h: أ · Q8: أ · Q9: أ · Q10: ب (0.50) · Q11: أ · Q12: ب · Q13: أ · Q14: ب · Q15: أ (حماده هلال / 220/8/2025) · Q16: أ · Q17: أ · Q18: ب · Q19: أ · Q20: ب · Q21: أ · Q22: ج · Q23: ب · Q24: ب · Q25: أ · Q26: أ (90) · Q27: ب · Q28: أ · Q29: أ (5/8/2025) · Q30a: — · Q30b: أ (500) · Q30c: أ (24) · Q30d: ب · Q30e: ب · Q30f: ب · Q30g: أ · Q30x: — · Q31: أ · Q32: ب · Q33: ب · Q34: أ · Q35: ب · Q36: إلغاء · Q37: أ · Q38a: ج · Q38b: أ · Q38c: ب · Q39: أ · Q40: أ · Q41: ب · Q42: إلغاء · Q43: أ

Plus two free-text rulings given with the answers (verbatim):

> **Q4** — "حسب التعاقد. أنواع التعاقد: مساحة ثابتة: سواء أشغلها أو لم يشغلها · مساحات متغيرة: حسب الإشغال. طرق المحاسبة: إيجار أسبوعي ولا يحسب كسور الأيام (تجبر لأسبوع) · الحساب الشهري: يحاسب بالشهر كامل ولا يجبر أيام الشهر (يجبر الشهر). عروض الأسعار لا تحجز أي مساحة على النظام إلا إذا تم التعاقد فعلياً."
> **Q5** — "دع الخيارين متاحين للمبيعات" (أ by position with the automatic block-type → ST map, and ج by cubic metre).

| Q | Answer | Meaning | Applied / where it lands |
|---|---|---|---|
| Q1 | ب 20% | Internal transfer price = cost + 20% | Gap #8 closed at decision level. Value lands in `catalog.price_lists` (`is_internal = true`) when 1.2 seeds price lists |
| Q2 | أ | Hard guard on resold partner services: warn < 15%, block < 10% unless GM approves | Gap #9. Build item for the partners slice; G-01 if a carrier is missing |
| Q3 | ب | Process owner (WH_MGR / DEL_MGR) matches the partner invoice · CFO approves | Gap #10. Seeds the `identity.sod_rules` pair + `approval_chains` row |
| Q4 | free text | **Contract types:** fixed space (billed whether occupied or not) · variable space (billed by occupancy). **Billing periods:** weekly rent rounds fractions **up to a full week**; monthly billing rounds **up to a full month**. **Quotes never reserve space**; only a signed contract does | Gap #72 answered with a new rule set. **Conflicts to resolve under G-01 before build (batched below):** (i) EXEC §1.1 makes ST-14 a *mandatory* clause and doc 17 §7 sources it from `wms.space_reservations`, while the GM's model bills fixed-space contracts on the contracted quantity itself; (ii) `wms.space_reservations` today is created from opportunities/quotes with mandatory `expires_at` — the GM's rule forbids that; (iii) `sales.contracts` has no `space_model (fixed·variable)` or `billing_period (weekly·monthly)` column — SCR needed |
| Q5 | أ + ج | Sales may sell shelf space **by position** (automatic block-type → ST map, CFO-editable) **or by cubic metre** | Gap #74. `space_allocations.uom` must allow `position` and `cbm`; the map is seeded as data (CFO). Requires the cbm denominator fix of D-13 §8-9 |
| Q6 | أ | ST-05…ST-10 stay in the catalog and are delivered via a partner (doc 09) | Gap #45 / S9 `partner_or_decline` → partner. Needs a partner contract before the first sale |
| Q7a | ج | Sales commission = **one-time amount at contract signature** | Gap #75 / D-14 D-1. Not the recommendation (ب recurring) |
| Q7b | ب | Rates **per client segment × service category** (not the flat 3/5/2/3) | Values not given — **carried** as a rate matrix (6 segments × 7 categories) before `hr.commission_rules` is seeded |
| Q7c | أ | Commission on **collected** cash | D-14 D-3 as recommended |
| Q7d | أ | Duration "no end" | **Moot under Q7a** (a one-time payment has no duration); recorded, nothing to apply |
| Q7e | ج | Monthly cap as a multiple of salary — **multiplier not given** | **Carried** — value needed before seeding |
| Q7f | ب | Sales manager 0.5% of the team's collected revenue | As recommended |
| Q7g | أ | No commission on pre-existing clients | Not the recommendation (ج half rate) |
| Q7h | أ | SCR-SC-01 approved | Migration number issued with the commission slice; pg-reviewer pre-migration review first |
| Q8 | أ | Pickup leg priced inside DL-01/02; catalog stays 92 | Closes SCR-TMS-PICKUP-01 §7 item 3 (D-137 carried item) |
| Q9 | أ | `wo.*` seven thresholds adopted provisionally; tuned after one month of data | Gap #66 closed; already seeded |
| Q10 | ب 0.50 | Warehouse productivity bonus **0.500 KWD per completed task** | Gap #67. `hr.commission_rules` row `applies_to = 'warehouse'` with SCR-SC-01 |
| Q11 | أ | The six warehouse task-exception codes adopted | Gap #70. Check constraint / reference table in the WO slice |
| Q12 | ب | Working hours stay undefined; out-of-hours fees (HD-13, DL-09) billed manually | Gap #71 closed as "manual" |
| Q13 | أ | Work orders billed on completion only | D-12 D-4 confirmed |
| Q14 | ب | WH_SUP may override the active-task limit with a recorded reason | D-12 D-5 |
| Q15 | أ "حماده هلال / 220/8/2025" | Structural engineer confirmation obtained | Gap #34 closed. **Date as typed is not a valid date** — recorded verbatim; GM to confirm 20/8/2025 or 22/8/2025 (batched) |
| Q16 | أ | DEL_MGR approves iMile driver-ID reassignment | Gap #39. Approver role + `assigned_by <> approved_by` constraint in the imile slice |
| Q17 | أ | Database governs `integration_queue` states; doc 23 §2-1 to be corrected | Gap #58 → documentary correction (next `docs(X)`) |
| Q18 | ب | File-import path for client orders: **new WBS task in Phase 2, after 2.11** | Gap #59. Doc 38 row to be added (Master issues the id; depends 2.11); small schema: unique `(client_id, client_ref)`, import batches table, `source_type` check list |
| Q19 | أ | Store-platform connectors I-12 as `6.2b` in Phase 6 | Gap #60. Staged row 6.2b already in `tasks/backlog/` → READY when 6.2 is DONE |
| Q20 | ب | Six languages on field cards, ar/en on admin boards | D-15 D-2 as recommended |
| Q21 | أ | `/inbox` becomes the board; decisions are one group | D-15 D-3 as recommended |
| Q22 | ج | No numeric clicks-to-done target | D-15 D-4 — not the recommendation |
| Q23 | ب | Per-process-group thresholds, tuned after a month | D-15 D-5 as recommended |
| Q24 | ب | Supervisor board shows overdue / at-risk / unowned only | D-15 D-6 as recommended |
| Q25 | أ | Deductions cap 25% provisionally until counsel | Gap #12. `platform.thresholds` `hr.max_deduction_pct = 25` marked provisional |
| Q26 | أ 90 | Probation **90 days**; confirmation criterion **not given** | Gap #40. Days seeded; criterion carried |
| Q27 | ب | Recruitment cost expensed in full in the month incurred | Gap #41. Overrides EXEC §1.3 "over the contract" — documentary correction |
| Q28 | أ | Client fines to commission drivers reduce the commission base (outside art. 38 cap) | Gap #42 confirmed; counsel confirmation still noted |
| Q29 | أ 5/8/2025 | PAM approved the penalty schedule; signed copies done | Gap #13 closed. `platform.settings` `hr.penalty_schedule_approved` → `true`, date 2025-08-05 (seed change, Master) |
| Q30a | — | Geofence carrier not chosen | **Carried** (the 500 m radius in Q30b implies a circle; GM to confirm أ) |
| Q30b | 500 | Geofence radius 500 m | `platform.thresholds` key with the SCR-HR-ATT-01 migration |
| Q30c | 24 | Punch records kept 24 months | Retention for `hr.attendance_punches` (ADR-0003 item 5 closed) |
| Q30d | ب | DEL_MGR approves driver device re-registration | ADR-0003 item 4a closed |
| Q30e | ب | Offline punches inside the geofence auto-accepted; out-of-geofence / unregistered → HR review | ADR-0003 item 3 closed |
| Q30f | ب | No attendance from the shared PDA; phone only | ADR-0003 item 1 closed (PDA path stays blocked) |
| Q30g | أ | GPS columns classified `personal` | ADR-0003 item 10 closed |
| Q30x | — | Biometric attendance **not** cancelled | — |
| Q31 | أ | CFO owns D03/D04/D05/D11 | Gap #35 confirmed as seeded |
| Q32 | ب | Credit-hold release needs a second approval (A0) | Gap #36. Seed change: that one operation → `A0`; the other eight stay `A1` |
| Q33 | ب | Approver derived from the requesting department | Gap #37 → **G-01 schema change** (`approval_chains.approver_role` → department-derived); post-pilot |
| Q34 | أ | `DOC` series confirmed | Gap #38 closed |
| Q35 | ب | DEPUTY_SYSADMIN named later, before Phase 4; CFO stays second approver | Gap #43 |
| Q36 | إلغاء | **No named domain owners** — the position is the owner | Gap #44 closed as cancelled; doc 22 "decision #1" and 28 §13 to be marked superseded |
| Q37 | أ | G8 anchor in `platform.settings` | ADR-0002 proposal confirmed; build before the first detach (≥ 2028-03) |
| Q38a | ج | Tax invoicing (C-05): not started | Gap #46 |
| Q38b | أ | Data-export permission (C-07): done | Gap #46 |
| Q38c | ب | iMile official API request: in progress | Gap #46 / X.6 |
| Q39 | أ | Secret scanner = **gitleaks** | 0.6a gate ⑥ |
| Q40 | أ | Rewrite doc 38 row 0.8 to local Docker | **Already applied** by the 0.8 commit (row 43 reads "Pilot acceptance … local Docker"); nothing further |
| Q41 | ب | P3 `REVOKE UPDATE, DELETE` on ledgers as a separate post-pilot task | Gap #14 → backlog row (Master issues the id) |
| Q42 | إلغاء | The seven unenforced policy controls are **removed from the policies** | Gap #25. **Before deleting, one check is owed:** at least the 7-day grievance window (doc 35 §0-1) may be statutory — legal counsel confirms which of the seven are company policy (deletable) and which are law (must stay). Batched |
| Q43 | أ | Closed value lists supplied by each domain owner after the pilot and enforced | Gap #15/#22/#23/#24 → post-pilot data task |

### Batched follow-ups for the GM (answered whenever convenient; nothing blocks the pilot)
1. **Q4** — the fixed/variable + weekly/monthly model contradicts the mandatory ST-14 clause (EXEC §1.1) and quote-based `space_reservations`. Confirm: ST-14 retired for fixed contracts (the contract quantity is billed) and `space_reservations` created **only from signed contracts**? The Master then files one SCR for `sales.contracts.space_model / billing_period`.
2. **Q7b** rate matrix (segment × category) and **Q7e** salary multiplier — values needed before the commission seed.
3. **Q15** date "220/8/2025" — 20 or 22 August 2025?
4. **Q26** — confirmation criterion at day 90.
5. **Q30a** — confirm circle (أ), since a 500 m radius was given.
6. **Q42** — counsel's list: which of the seven controls are statutory.
