# تدقيق حالة المستودع — 2026-09-23 (قراءة فقط) · تحديث بعد `f790da7`
كل رقم ناتج أمر نُفّذ في هذه الجلسة؛ أُعيد تشغيل الأقسام 1·2·6·7·8 بعد commit ‏1.5. لم يُعدَّل كود ولا commit ولا apply.sh. `pnpm` غير موجود على PATH في Git Bash، فشُغِّل بـ `node …/npm/node_modules/pnpm/bin/pnpm.cjs` (9.15.9).
## 1. الهوية
| البند | النتيجة |
|---|---|
| `git remote -v` | **فارغ — لا يوجد remote**؛ النسخة الوحيدة على هذا القرص |
| الفرع · عدد الـcommits | `main` · 56 (13 wip · 7 feat) |
| آخر commit | `f790da7 feat(1.5): customer accounts proof slice (ADR-0001)` — 17 ملفاً، 347+ / 109−، trailers: Model opus/sonnet · Review PASS(35) |
| `git status --short` | نظيف عدا `?? docs/notes/2026-09-23-repo-audit.md` (هذا التقرير) |
| commits بلا `type(scope):` | 9 (`bab005a` · `a901a04` · `1bc09f7` Revert · `52ec6d6` · `cee26d4` · `72244e7` · `41cbbc0` · `d734508` · `3218aa6`) — كلها أقدم من hook الرسالة |
| commits بنطاق ليس رقم WBS ولا `X` | 7: `05674b5 build(monorepo)` · `aca1b16 chore(bootstrap)` · `42c72ba feat(i18n)` · `8d62747 docs(i18n)` · `f228a01 chore(lint)` · `ec8dd91 chore(env)` · `1577a12 docs(0.9/0.18)` |

## 2. الحالة الرسمية
**PROJECT_STATE.md (ملتزَم في `f790da7`، 55 سطراً):** المهمة الحالية «1.5 — DONE (proof)» · الإنجاز 13/132 (0.17 و1.5 مستثناتان — ADR-0001) · SCR-TRGM-01 محلولة (خيار A) · 2.6 READY.

| آخر 5 DONE | الهاش |
|---|---|
| 1.5 proof (ADR-0001) + SCR-TRGM-01 خيار A | `f790da7` في git؛ الملفان ما زالا يكتبان «this commit» — يُسجَّل في commit المهمة التالية (قاعدة GIT B3) |
| 2.8 سجل المخزون | `b5da282` |
| 2.1 WH1 proof | `0d546d5` |
| 0.18 عزل RLS 43/43 | `f03e160` |
| 0.17 آليات الهوية | `c90dd6e` |

**العوائق المسجلة:** تكافؤ صورة postgres:16 بين التطوير والمستوى 0 — حُسم بقرار GM ‏D-105 (postgres:16 Debian/glibc) · G-01 مفتوح لمرساة G8 · 2.2 و0.2 و0.8 WAITING_GM · بوابة المرحلة 0 مفتوحة فلا تبدأ 2.9 · إرث 0.18 (`entity_scope` FOR ALL/USING، التشغيل كـ superuser).

| حالة MASTER_BACKLOG | العدد | قبل `f790da7` |
|---|---|---|
| TODO | 79 | 80 |
| READY | 7 (1.2 · 2.6 · 3.1 · 3.3 · 3.14 · 5.13 · 6.4) | 6 |
| ACTIVE | 0 | 0 |
| WAITING_GM | 26 | 26 |
| BLOCKED | 0 | 1 (1.5) |
| DONE | 15 | 14 |
| خارج الأسطورة | CONTINUOUS 6 (X.1–X.6) · DEFERRED 1 (0.19) | نفسها |
مجموع الصفوف = 134 بينما رأس الملف يقول 132 (و`check-setup.sh` يعدّ «132 doc-38 rows»). LANE_LOCKS: لا أقفال (قُفل sales حُرِّر).

## 3. التناقضات بين الوثائق والواقع
| # | الوثيقة | تقول | الواقع |
|---|---|---|---|
| 1 | SETUP-STATUS-AR.md (آخر تحديث 22/9) | المهمة الحالية 0.14؛ 0.9 محجوبة لأن psql مفقود | 0.14 و0.9 منجزتان؛ `psql 16.15` مثبّت؛ 1.5 منجزة |
| 2 | README-KIT.md:56 | pg-scribe = haiku | `.claude/agents/pg-scribe.md` = sonnet؛ CLAUDE.md: «no haiku» |
| 3 | `.claude/briefs/_slice-2.1.brief.md:6` | pg-scribe (haiku) | نفس ما سبق |
| 4 | README-KIT.md:95 | PROJECT_STATE مهيأ على BOOTSTRAP-001 → 0.4 | وصف تاريخي لم يُحدَّث |
| 5 | PROJECT_STATE:15 «Setup check» | `check-setup.sh` → FILES READY | **NOT READY** (6 MISS — القسم 8) — ما زال قائماً بعد `f790da7` |
| 6 | صف 0.17 في BACKLOG | نسبة الإنجاز 12/132 | PROJECT_STATE يقول 13/132 |
| 7 | PROJECT_STATE (Phase) | «2.1 started 2026-09-23» | 2.1 DONE @ `0d546d5` |
| ✔ | ~~migrations 0001–0005~~ · ~~1.5 غير ملتزَمة~~ | — | **أُصلحا** في `f790da7` (السطر يقول الآن 0001–0006) |

## 4. مساحة العمل
| المجلد | ملفات (متتبَّعة) | WBS حسب git log | أول commit |
|---|---|---|---|
| packages/contracts | 19 (19) | 0.13 | `f411254` |
| packages/db | 11 (11) | 0.11 | `a192a72` |
| packages/documents | 7 (7) | 0.15 | `954ff3a` |
| packages/domain-kit | 13 (13) | 0.14 | `a8f4899` |
| packages/events | 12 (12) | 0.12 · 2.8 | `4164eb0` |
| packages/identity | 14 (14) | 0.17 | `f5e727d` |
| modules/identity | 6 (6) | 0.4 («monorepo») · 0.16 | `05674b5` |
| modules/platform | 12 (12) | 0.4 · 0.9 · 0.10 · 1.5 | `05674b5` |
| modules/sales | 7 (7) | 1.5 (`0b6ffbb` wip + `f790da7` feat) | `0b6ffbb` |
| modules/wms | 23 (23) | 2.1 · 2.8 | `0d546d5` |
| tests/guards · tests/load · tests/scenarios | 1 · 1 · 1 | 0.4 («monorepo») — هياكل فارغة | `05674b5` |
| tests/isolation | 6 (6) | 0.9 · 0.18 | `428a565` |
| apps/ | **فارغ (0)** | — | — |
لا يوجد مجلد «بلا أثر». تحفّظ: `modules/identity` و`modules/platform` و`tests/{guards,load,scenarios}` أثرها `build(monorepo)` وليس نطاق WBS صالحاً (المقصود 0.4).

## 5. التبعيات
| البند | النتيجة |
|---|---|
| `pnpm why zod -r` | zod **4.6.5** مباشر في `@pg-eos/contracts` (+ peer لـ zod-openapi 6.0.2)؛ zod **3.25.76** عابر فقط عبر `@pg-eos/documents → puppeteer 25.11.0 → chromium-bidi 17.0.2`. لا يستخدم كودنا v3 |
| packages/identity ↔ modules/identity | اسما الحزمتين مختلفان (`@pg-eos/identity-mechanisms` / `@pg-eos/identity`) فلا تعارض في pnpm، لكن اسم المجلد مكرر ويُربك الموجِّهين والـbriefs |
| NestJS · Fastify · XState · pg-boss | **غير مثبّتة** — لا تظهر في أي package.json ولا في `node_modules/.pnpm`؛ المثبّت فقط drizzle-orm 0.45.3 |

## 6. البوابات محلياً (أُعيدت بعد `f790da7`)
| البوابة | النتيجة |
|---|---|
| `pnpm lint` | PASS — 0 أخطاء |
| `pnpm lint:boundaries` | PASS — BOUNDARIES ENFORCED A–F (التشغيل الأول) |
| `pnpm typecheck` | PASS — 14/14 مهمة |
| `pnpm test` | PASS — 13/13 مهمة، 10 مشاريع، **330 اختباراً**: domain-kit 87 · wms 85 · contracts 44 · identity-mechanisms 31 · platform 24 · sales 19 · identity 15 · db 11 · events 8 · documents 6. **12/13 من كاش turbo**؛ نُفِّذ فعلياً `@pg-eos/sales` فقط (cache miss) |

## 7. البيئة
| البند | النتيجة |
|---|---|
| `psql --version` | 16.15 |
| `docker compose … ps` | **يفشل** بدون `PGADMIN_PASSWORD`؛ بتعيينه: `pg-eos-postgres` (postgres:16) healthy، 127.0.0.1:5432 |
| قاعدة pgeos | موجودة · collate `C` / ctype `C.UTF-8` · 175 جدولاً في 14 مخططاً · view 0006 (`>= 0.85`) مطبَّق وملفه الآن ملتزَم |
| `pnpm guards:run` | PASS — G1–G14 وG18 وG-SEED = 0 صفوف؛ G15–G17 **لم تُشغَّل** (Playwright/Stryker/trace غير موجودة) |

## 8. الطقم
| البند | النتيجة |
|---|---|
| `grep -c inherit .claude/agents/*` | 0 في الملفات الخمسة؛ reviewer=opus والباقي sonnet |
| briefs | 21 ملفاً (15 وحدة + 5 `_slice`/0.18 + قالب)؛ الأطول `_slice-2.8` = 219 سطراً |
| `bash -n` | OK للثمانية: hooks (2) · commit-msg · scripts (4) · apply.sh |
| `core.hooksPath` | `.githooks` ✔ |
| `bash scripts/check-setup.sh` | **NOT READY (exit 1)** — 6 MISS: عدد briefs 20 (المتوقع 15) + خمسة > 120 سطراً (0.18=208 · 0.17=162 · 1.5=146 · 2.1=140 · 2.8=219) · 1 WARN (`claude` غير على PATH) |
| `.golden-slice-accepted` | غير موجود — `new-slice.sh` بلا أثر |

## 9. المخاطر (الأخطر أولاً)
| # | الخطر | الدليل | التوصية | المرجع |
|---|---|---|---|---|
| 1 | لا يوجد remote — نسخة واحدة على القرص | `git remote -v` فارغ؛ حادثة `a901a04` | remote خاص (قرار GM) — شرط مسبق لـ 0.6 CI | 0.6 · X |
| 2 | PROJECT_STATE يدّعي FILES READY والواقع NOT READY | القسم 8 | إخراج briefs الشرائح إلى `docs/notes/` أو تقليمها ≤ 120، وتصحيح السطر | CLAUDE.md QUOTA · X |
| 3 | نتائج الاختبار من الكاش؛ turbo لا يدخل `PG*` في الـhash | `Cached: 12/13` | `pnpm test -- --force` قبل كل commit يلمس القاعدة؛ إصلاح inputs في turbo.json | إرث 0.18 (8) |
| 4 | حزمة الـstack غير مثبّتة (Nest/XState/pg-boss) والشريحة الذهبية غير مبنية | القسم 5؛ apps/ فارغ | لا عمل عليها قبل إغلاق بوابة المرحلة 0 | 2.9 · 0.2 · 0.8 |
| 5 | التشغيل كـ superuser و`entity_scope` يحكم INSERT | PROJECT_STATE Blockers | تصميم الأدوار ضمن 0.5/0.6 | 0.18 · SCR-RLS-01 |
| 6 | وثائق متقادمة تضلّل القارئ البشري | القسم 3 (#1–#4) | تحديث SETUP-STATUS-AR وREADME-KIT عبر pg-scribe | X |
| 7 | G15–G17 لم تُشغَّل قط | مخرج guards-run | تُبنى مع 0.6 وأول سيناريو | doc 40 Part F · 0.6 |
| 8 | `docker compose ps` يفشل بلا متغير | القسم 7 | قيمة افتراضية dev أو `.env.example` | 42 §4.2 |
| 9 | تكافؤ صورة dev/Tier-0 (glibc/musl) يؤثر على locale | PROJECT_STATE | قرار GM قبل 0.5 | 42 §9 |
| 10 | ازدواج اسم identity | القسم 5 | توثيق الفرق في briefs/identity | 0.17 |
| 11 | 16 commit بلا نمط WBS صالح | القسم 1 | تاريخي؛ الـhook يمنع التكرار — لا إعادة كتابة | CLAUDE.md GIT |
| ✔ | ~~إغلاق 1.5 غير ملتزَم~~ | — | **أُغلق** في `f790da7` | 1.5 |

## 10. المهمة القادمة حسب /pg-resume
1. تبعية 2.6 (أي 1.5) صار لها هاش في git (`f790da7`)، والشجرة نظيفة، ولا أقفال — فشرط /pg-resume «every dependency DONE with a hash» متحقق.
2. الصفوف READY بترتيب الجدول: 1.2 أولاً، لكن معيار قبولها «rejected from UI, API and import» غير قابل للتشغيل (لا apps/ ولا API ولا شريحة ذهبية) = عائق حقيقي حسب /pg-resume. 3.1 و3.3 تحتاجان مسار تعيين (جداول TMS/HR)، و3.14 و5.13 و6.4 تحتاج خدمات وواجهات غير موجودة.
3. **لذا: 2.6 `wms.skus`** (المسار 2، 🤖) — معيارها «Cross-client SKU mix rejected» قابل للإثبات على مستوى القاعدة كما في 2.1/2.8، وتبنى على `modules/wms`. PROJECT_STATE:45 يسجّلها «خارج التوجيه الحالي — بانتظار GM»، فبدؤها يحتاج إذن GM. commit ‏2.6 يسجّل هاش `f790da7` مكان «this commit».
