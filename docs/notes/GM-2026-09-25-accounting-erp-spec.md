# GM directive 2026-09-25 — PREMIUM GROUP — ENTERPRISE ACCOUNTING & ERP SYSTEM (verbatim)

Source: GM, pasted into the session "تقييم المشروع والمسار القادم" on 2026-09-25, with the instruction
"قم بجدوله وصياغه هذه الاوامر بشكل مناسب للمشروع باحترافيه ودفه صارمه واصدارها لماستر في الوقت المناسب".
The text below is the GM's, unedited. It is the governing source for the accounting track (A-track).

---

PREMIUM GROUP — ENTERPRISE ACCOUNTING & ERP SYSTEM

STRICT IMPLEMENTATION SPECIFICATION FOR CLAUDE CODE

أنت تعمل كـ Senior Enterprise Software Architect + Senior Financial Systems Engineer + Accounting Systems Specialist.

مهمتك هي تصميم وتنفيذ نظام محاسبي مؤسسي احترافي لمجموعة Premium Group، مع الالتزام الصارم بالدقة المحاسبية، سلامة البيانات، قابلية التدقيق، الأمان، وقابلية التوسع.

لا تتعامل مع المشروع كنظام فواتير بسيط، ولا تبدأ بكتابة الكود مباشرة قبل تحليل المتطلبات ووضع Architecture واضح.

1. الهيكل القانوني للمجموعة

الشركة الأم: Premium Group Holding
والشركات التابعة: 1. Premium Storage 2. Premium Delivery 3. Premium Order 4. Premium CC

يجب أن يكون النظام Multi-Company من البداية.
كل شركة يجب أن تمتلك: Legal Entity مستقل · Accounting Books مستقل · Chart of Accounts · Fiscal Periods · Customers · Vendors · Employees · Bank Accounts · Cash Accounts · Fixed Assets · Revenue · Expenses · Cost Centers
مع إمكانية إنشاء تقارير موحدة للمجموعة.

2. قاعدة أساسية

يجب الفصل بشكل صارم بين: Legal Entity و Branch و Station و Warehouse و Department و Cost Center
لا تستخدم الحسابات المحاسبية لتمثيل الفروع أو المحطات. يجب استخدام Dimensions مستقلة.

3. Chart of Accounts

اعتمد الهيكل التالي: 1 — Assets · 2 — Liabilities · 3 — Equity · 4 — Revenue · 5 — Cost of Revenue · 6 — Operating Expenses · 7 — Other Income / Expense · 8 — Tax · 9 — Control / Memorandum Accounts
صيغة الحساب: X-XX-XXX-XXX  مثال: 1-01-001-001
يجب أن يكون Chart of Accounts قابلًا للتوسع والتعديل بدون تغيير Database Structure. لا تجعل الحسابات Hard-Coded داخل الكود.

4. Accounting Engine

النظام يجب أن يعتمد على Double-Entry Accounting بشكل كامل. كل Journal Entry يجب أن يحقق: Total Debit = Total Credit، ولا يسمح النظام بترحيل قيد غير متوازن.
يجب دعم: Manual Journal · Automatic Journal · Recurring Journal · Reversing Journal · Adjustment Journal · Accruals · Prepayments · Closing Entries

5. Accounting Periods

يجب إنشاء: Fiscal Year · Accounting Period · Open Period · Closed Period · Locked Period
بعد إغلاق الفترة: لا يسمح بتعديل أو حذف القيود المرحلة. أي تصحيح يتم من خلال Reversal / Adjustment Entry مع Audit Trail كامل.

6. Dimensions

كل Transaction يجب أن يدعم عند الحاجة: Company · Branch · Station · Warehouse · Department · Cost Center · Project · Customer · Vendor · Employee · Vehicle · Shipment · Intercompany Entity
يجب تصميم Dimensions بحيث يمكن إضافة Dimensions جديدة مستقبلًا بدون إعادة بناء النظام.

7. Multi-Company

كل Transaction يجب أن تكون مرتبطة بـ company_id، ويجب منع أي مستخدم من الوصول إلى بيانات شركة لا يملك صلاحية الوصول إليها. الـ Group Admin / Group CFO يستطيع رؤية المجموعة بالكامل حسب الصلاحيات.

8. Intercompany Accounting

يجب تنفيذ Intercompany Accounting بشكل أصلي داخل النظام.
مثال: Premium Storage يقدم خدمة إلى Premium Delivery. في Storage: Dr Intercompany Receivable / Cr Revenue. في Delivery: Dr Expense / Cr Intercompany Payable.
يجب أن ينشئ النظام الطرف المقابل تلقائيًا. يجب وجود: Due From · Due To · Intercompany Invoice · Intercompany Journal · Intercompany Reconciliation · Elimination Entries

9. Consolidation

يجب أن يستطيع النظام إنشاء Company Financial Statements لكل شركة بشكل مستقل، و Group Consolidated Financial Statements للمجموعة بالكامل.
يجب أن يدعم Consolidation: Elimination of Intercompany Revenue · Expenses · Receivables · Payables · Balances · Investment in Subsidiaries · Non-Controlling Interest إذا لزم
ولا يجوز خلط الحسابات الأصلية للشركات مع حسابات Consolidation.

10. Premium Storage — يجب دعم: Warehouses · Storage Contracts · Storage Revenue · Handling · Loading / Unloading · Inventory Management · Warehouse Expenses · Warehouse Cost Centers · Customer Storage Billing

11. Premium Delivery — يجب دعم: Shipments · Drivers · Vehicles · Stations · Delivery Jobs · Delivery Fees · COD · Failed Delivery · Return Delivery · Driver Settlement · Vehicle Expenses · Fuel · Maintenance · Delivery Partner Costs

12. COD Accounting

هذه وظيفة أساسية. يجب ألا يعتبر النظام COD Revenue تلقائيًا.
يجب فصل: Customer Receivable عن COD Collection عن Driver Clearing عن Company Bank/Cash
يجب معرفة: قيمة COD · من قام بالتحصيل · تاريخ التحصيل · تاريخ التسوية · المبلغ المسلم · أي نقص · أي فرق · حالة التسوية
ويجب إنشاء Accounting Entries تلقائيًا.

13. Premium Order — دعم: Orders · Order Processing · Order Fulfillment · Order Fees · Customer Billing · Revenue Recognition · Order-related Costs

14. Premium CC — دعم: Call Center · Agents · Customer Service · Call Handling · Contracts · Billing · Telecom Costs · Software Costs · Employee Costs

15. Accounts Receivable — يجب دعم: Customers · Customer Accounts · Invoices · Credit Notes · Debit Notes · Receipts · Allocations · Customer Statements · Aging · Overdue Amounts · Credit Limits

16. Accounts Payable — يجب دعم: Vendors · Bills · Credit Notes · Payments · Payment Allocation · Vendor Statements · Aging · Approval Workflow

17. Purchasing — Workflow: Purchase Request → Approval → Purchase Order → Goods/Service Receipt → Supplier Invoice → Payment
يجب دعم Three-Way Matching عند الحاجة: PO + Receipt + Invoice

18. Sales — Workflow: Quotation → Sales Order → Delivery / Service → Invoice → Receipt
مع دعم: Discounts · Credit Notes · Debit Notes · Partial Payments · Customer Credit Limit

19. Banking — دعم: Multiple Banks · Multiple Bank Accounts · Bank Transactions · Transfers · Deposits · Withdrawals · Bank Reconciliation · Outstanding Checks / Payments · Statement Import
يجب عدم تسجيل Bank Reconciliation كعملية محاسبية إلا عندما تكون هناك حاجة فعلية لقيد.

20. Cash — دعم: Main Cash · Petty Cash · Cash Custodians · Cash Receipts · Cash Payments · Cash Transfers · Cash Count · Cash Reconciliation

21. Fixed Assets — دعم: Asset Register · Asset Categories · Acquisition · Capitalization · Depreciation · Disposal · Transfer · Impairment · Accumulated Depreciation
يجب أن يكون Depreciation Engine مستقلًا وقابلًا للإعداد.

22. Expenses — دعم: Expense Claims · Employee Expenses · Supplier Expenses · Recurring Expenses · Prepaid Expenses · Accrued Expenses — مع Approval Workflow.

23. Employees & Payroll

يجب تصميم Payroll Module بطريقة منفصلة وقابلة للتكامل مع Accounting.
يجب دعم: Employees · Salaries · Allowances · Deductions · Overtime · Benefits · Accommodation · Transportation · Medical Insurance · Residency/Iqama Costs
لا تفترض أي نسب أو قوانين محلية دون إعدادها كـ configurable rules.

24. Audit Trail — هذه وظيفة إلزامية.

يجب تسجيل: Created By/At · Updated By/At · Approved By/At · Posted By/At · Old Value · New Value · Action · Reason · User · Session
لا يسمح بحذف Journal Entries المرحّلة.

25. Approval Workflow

يجب إنشاء Workflow Engine قابل للتهيئة. مثلاً: Expense → Accountant → Finance Manager → CFO · Purchase Order → Department Manager → Finance → Management · Payment → Accountant → Finance Manager → Authorized Signatory
يجب ألا تكون مستويات الموافقة Hard-Coded.

26. User Roles

يجب دعم: Super Admin · Group Admin · Group CFO · Finance Manager · Chief Accountant · Accountant · AR Accountant · AP Accountant · Treasury · HR · Operations Manager · Warehouse Manager · Station Manager · Auditor · Read Only
مع صلاحيات على مستوى: Company · Branch · Module · Action · Record

27. Security

التزم بأفضل ممارسات Enterprise Security. يجب دعم: Authentication · Authorization · Role Based Access Control · Company-level Permissions · MFA-ready Architecture · Secure Password Hashing · Session Management · API Authentication · Rate Limiting · Input Validation · SQL Injection Protection · CSRF Protection · XSS Protection · Encryption where appropriate · Secure Secrets Management
لا تضع Passwords أو API Keys داخل Source Code.

28. Database

صمم قاعدة البيانات بطريقة Normalized + Scalable + Auditable، مع: Primary Keys · Foreign Keys · Unique Constraints · Check Constraints · Indexes · Transactions · Soft Delete حيث يلزم · Immutable Accounting Records
لا تستخدم Database Design يسمح بوجود orphan records.

29. API Architecture

صمم API واضحة ومنظمة. يفضل REST API أو Architecture مناسبة للنظام.
يجب الفصل بين: Authentication · Users · Companies · Accounting · GL · AR · AP · Banking · Inventory · Assets · Payroll · Intercompany · Consolidation · Reporting
كل API يجب أن تتحقق من: Authentication + Authorization + Company Access + Input Validation

30. Reporting Engine

يجب بناء Reporting Layer مستقلة. التقارير المطلوبة: Trial Balance · General Ledger · Balance Sheet · Income Statement · Cash Flow · Statement of Changes in Equity · AR Aging · AP Aging · Customer Statement · Vendor Statement · Bank Reconciliation · Expense Analysis · Revenue Analysis · Cost Center P&L · Branch P&L · Station P&L · Company P&L · Group Consolidated P&L · Group Consolidated Balance Sheet · Intercompany Reconciliation · COD Reconciliation
يجب دعم: PDF · Excel · CSV — ويمكن إضافة JSON/API لاحقًا.

31. IFRS Readiness

صمم النظام ليكون قادرًا على دعم IFRS. لا تضع قواعد IFRS بطريقة Hard-Coded يصعب تعديلها. يجب إنشاء طبقة Accounting Rules / Financial Reporting Rules بحيث يمكن تحديثها مستقبلًا.
يجب تصميم النظام ليكون جاهزًا لمتطلبات IFRS 18، بما في ذلك متطلبات عرض وتصنيف المعلومات المالية والإفصاحات ذات الصلة.

32. XBRL Readiness

XBRL يجب أن يكون Layer مستقل. Architecture: Transaction → General Ledger → Financial Statements → IFRS Mapping → XBRL Taxonomy Mapping → Validation → XBRL Export
لا تجعل XBRL جزءًا صلبًا من Accounting Engine. يجب أن نستطيع تغيير Taxonomy مستقبلًا.

33. Kuwait Localization

صمم النظام بحيث يكون جاهزًا للمتطلبات الكويتية دون Hard-Coding. يجب أن تكون: Tax Rules · Invoice Rules · Payroll Rules · Government Reporting Rules · Accounting Rules — قابلة للإعداد والتحديث.
لا تفترض وجود ضريبة أو نسبة ضريبية معينة دون إعداد رسمي.

34. Data Integrity — هذه نقطة حرجة.

يجب أن يمنع النظام: Unbalanced Journal Entries · Duplicate Invoice Numbers · Duplicate Payment · Invalid Company Access · Posting to Closed Period · Invalid Account · Invalid Currency · Invalid Intercompany Pair · Negative Inventory إذا كانت السياسة تمنعه · Duplicate COD Settlement · Unauthorized Modification

35. Currency

صمم النظام Multi-Currency من البداية. لكل Transaction: Transaction Currency · Functional Currency · Exchange Rate · Base Amount · Foreign Amount
ويجب دعم: Realized FX Gain/Loss · Unrealized FX Gain/Loss — وفق إعدادات النظام والسياسة المحاسبية.

36. Dashboard

يجب إنشاء Dashboard للإدارة العليا يعرض: Revenue · Gross Profit · Operating Profit · Cash · Bank · Receivables · Payables · COD Outstanding · Intercompany Balance · Expenses · Company Performance · Branch Performance · Station Performance
مع Drill Down: Group → Company → Branch → Station → Department → Account → Transaction

37. Development Rules

ممنوع: كتابة Prototype ثم اعتباره Production System · Hard-Coding للبيانات المحاسبية · Hard-Coding للصلاحيات · Hard-Coding للشركات · حذف القيود المرحّلة · تجاوز Accounting Engine · إنشاء تقارير منطقها مختلف عن General Ledger · تكرار منطق المحاسبة في عدة Modules
يجب أن يكون: Single Source of Truth = General Ledger

38. Testing

لا تعتبر أي Module مكتملًا بدون Tests. يجب إنشاء: Unit · Integration · Accounting · API · Permission · Multi-Company · Intercompany · Consolidation · Regression · Security Tests
خصوصًا Accounting Invariant: في كل Journal Entry SUM(DEBIT) = SUM(CREDIT) ويجب اختبارها آليًا.

39. Implementation Method

لا تبدأ ببناء جميع Modules دفعة واحدة. نفذ المشروع على مراحل:
Phase 1: Architecture · Database · Authentication · Users · Roles · Companies · Branches · Dimensions · Chart of Accounts
Phase 2: Accounting Engine · Journal · GL · Periods · Posting · Reversal · Audit Trail
Phase 3: AR · AP · Customers · Vendors · Invoices · Payments
Phase 4: Banking · Cash · Reconciliation
Phase 5: Purchasing · Sales · Inventory
Phase 6: Premium Storage · Premium Delivery · Premium Order · Premium CC
Phase 7: COD · Drivers · Vehicles · Stations
Phase 8: Fixed Assets · Expenses · Payroll
Phase 9: Intercompany · Consolidation
Phase 10: Financial Reporting · IFRS Readiness · XBRL
Phase 11: Security Hardening · Performance · Backup · Monitoring · Production Deployment

40. Mandatory Development Protocol

قبل تنفيذ أي Phase: 1. Analyze requirements. 2. Identify ambiguities. 3. Define architecture. 4. Define database schema. 5. Define business rules. 6. Define API contracts. 7. Define permissions. 8. Define accounting entries. 9. Write tests. 10. Implement. 11. Run tests. 12. Review implementation. 13. Fix errors. 14. Document the completed Phase.
لا تنتقل إلى Phase التالية إذا كانت الاختبارات الأساسية للمرحلة الحالية تفشل.

41. Accounting Documentation

لكل عملية محاسبية داخل النظام يجب أن يكون لها Documentation يوضح: Business Event → Accounting Rule → Debit Account → Credit Account → Dimensions → Tax Treatment → Approval → Posting → Reporting Impact
مثال COD Collection: Business Event → Shipment COD Collected → Driver Clearing → Customer Receivable Settlement → Cash/Bank Settlement

42. Code Quality

الكود يجب أن يكون: Clean · Modular · Typed where applicable · Testable · Documented · Maintainable · Secure · Scalable
استخدم Design Patterns عندما تكون مناسبة، وليس لمجرد التعقيد. تجنب: God Classes · God Functions · Duplicate Logic · Circular Dependencies · Magic Numbers · Magic Strings

43. Documentation

يجب إنشاء: README.md · ARCHITECTURE.md · DATABASE.md · ACCOUNTING_RULES.md · API.md · SECURITY.md · TESTING.md · DEPLOYMENT.md · CHANGELOG.md — وDocumentation خاصة بكل Module.

44. Critical Requirement

قبل اتخاذ أي قرار محاسبي غير منصوص عليه هنا، لا تخمن. إذا كانت هناك نقطة تحتاج قرارًا تجاريًا أو محاسبيًا أو قانونيًا: اعرضها كـ Open Decision / Assumption ولا تضع قاعدة من عندك داخل النظام.
خصوصًا في: Tax · IFRS interpretation · Payroll law · Kuwait regulatory requirements · Revenue Recognition · Intercompany treatment · Depreciation policies

45. Definition of Done

لا تعتبر المشروع مكتملًا لمجرد أن الواجهة تعمل. يعتبر النظام مكتملًا فقط عندما: Accounting Engine يعمل · Debit/Credit integrity مضمونة · Multi-Company يعمل · Intercompany يعمل · Consolidation يعمل · Audit Trail يعمل · Permissions تعمل · Period Closing يعمل · AR/AP يعملان · Bank Reconciliation يعمل · Reports تطابق General Ledger · COD reconciliation يعمل · Tests تمر بنجاح · Security review مكتمل · Documentation مكتملة · Backup/Recovery strategy موجودة · Production deployment موثق.

FINAL INSTRUCTION

ابدأ أولًا بعمل Repository Audit للمشروع الحالي.
إذا كان المشروع يحتوي على كود موجود: لا تحذف الكود الموجود · افحص Architecture الحالي · حدد ما يمكن إعادة استخدامه · حدد المشاكل · حدد الملفات المتأثرة · اقترح Migration Plan.
إذا كان المشروع فارغًا: ابدأ من Architecture الصحيح.
لا تبدأ بكتابة آلاف الأسطر من الكود مباشرة. ابدأ بإنتاج: 1. System Architecture 2. Module Architecture 3. Database ERD 4. Data Model 5. Accounting Model 6. Permission Model 7. API Structure 8. Development Roadmap
ثم بعد مراجعة الاتساق الداخلي، ابدأ التنفيذ تدريجيًا. كل مرحلة يجب أن تكون Production-Quality وليست Demo أو Prototype.

الهدف النهائي: Enterprise-grade accounting and ERP platform for Premium Group Holding and its four subsidiaries, with strong accounting integrity, multi-company support, intercompany accounting, consolidation, auditability, IFRS readiness, and XBRL readiness
