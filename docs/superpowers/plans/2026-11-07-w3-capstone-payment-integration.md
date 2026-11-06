# W3 Capstone Payment Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kết nối phí giao W3 70/30 vào hóa đơn, tiền mặt, ví thợ và thanh toán sẵn có để nhóm SEP490 demo bằng đơn thật, không thêm quy trình Finance/pháp lý.

**Architecture:** Reuse positive W3 fee-terms journal (0010), existing operational physical DELIVERY journal, approved AdditionalCost and invoice/settlement stack. Snapshot fee/consent/physical real source at invoice creation; additive DB migration opens W3 invoice safely. Modify consumer cutover in narrowly scoped steps, not global bypass.

**Tech Stack:** NestJS, TypeORM, PostgreSQL 16, Vitest, Vue3 Web, existing JWT/Admin RBAC, GitHub CI, DEV VPS.

**Spec:** `docs/W3_CAPSTONE_PAYMENT_SPEC.md`

## Global Constraints

- This is an academic DEV demonstration. **No legal/Finance signoff required to develop/test/use existing demo payment rails.** Never present a false bank payment success.
- No PROD/main deploy; preserve legacy W1/W2/PICKUP, completed invoices, wallets, customers, VNPay, cash, vouchers, visit-groups and warranty.
- Owner-approved split W3_70_30_V1: per shipment c=floor((S*7+5)/10), t=S-c; S is FULL courier cost. With L=200000, C=20000, S=30000, customer pays 221000; cash wallet debit=50000; verified online wallet credit=171000.
- Admin `commission.rate_bps` may be zero. `w3.shipping.max_new_fee_vnd` is new quote safety cap, zero means no positive NEW quote; Admin explicitly raises it for positive demo.
- One authoritative actual/quote source, unique request, dual consent, actor ownership, order locks, CAS/version and idempotent wallet postings; never treat preparatory simulation D/commission as money authority.
- No direct real-money transfer triggered from backend; manual bank confirmation must be authorized, amount-correct, single-use and auditable; never mark as paid from a client screenshot.
- No blanket removal of `assertShippingFinancialCutoverAllowed`, no override via generic env or admin flag. Replace with a narrow W3 invoice+verified delivery predicate, applied in every W3 money consumer.
- Run at least `npm run lint`, `npm run typecheck`, `npm run build`, relevant `npm test`; isolated PostgreSQL W3 schema and full payment integration before merge or DEV deploy. No shared DB writes for local tests.
- Preserve `docs/CONTEXT.md` latest log protocol (max 40 log entries), plan tracked, add tests before implementation. No speculative schema or new finance ledger if current infrastructure suffices.

## Review Focus (add regression in owning tasks)

1. Paid W3 with 2 shipments S=1 each: per-shipment rounded customer 2, tech 0, no aggregate rounding divergence; invoice DB CHECK must accept but not arbitrary fake shares.
2. Race: concurrent duplicate cash/online/manual-transfer confirmation must generate exactly one invoice PAID and one wallet posting.
3. Historical legacy invoice with positive shipping continues legacy 100/0, not retroactively converted to W3; paid invoice immutable even if consent drifts.
4. Missing/stale approved fee, absent either consent, fee>quote/source, no physical receipt, or insufficient L-C-Σt refuses W3 invoicing/collection.
5. Cash + online + cancelled/refunded + W1/W2/PICKUP/group/voucher paths remain compatible; no double-counted courier S or bank transfer credited before verification.

---

### Task 1: Audit, golden baseline and W3 integration contract (first implementation slice)

**Files:**
- Create: `docs/W3_CAPSTONE_AUDIT.md`
- Modify: `docs/W3_CAPSTONE_PAYMENT_SPEC.md` (only if code audit proves a mistaken assumption).
- Test: `src/modules/finance/shipping-finance.policy.spec.ts`, `src/modules/finance/w3-cutover.spec.ts`, relevant tests.

**Interfaces:** Produces a verified path matrix for: additional-cost approval, `/delivery/terms` vs `/delivery` journals, invoice generation, cash intent, paid online, wallet settlement, schema CHECK and Web consumer contract.

- [x] Inspect exact named code and current schema/CI; document confirmed W3 blockers, legacy use and DB constraints. Audit whether direct bank transfer exists (do not invent).
- [x] Write RED regression tests for 200k/20k/30k split cash=50k, online=171k, 0 commission and 2x 1-VND shipment half-up. Run focused test, note RED/green where existing pure policy already works.
- [x] Refine spec with non-guessing source choices and bounded PR sequence. Keep old `w3-cutover.spec.ts` blocking tests until the specific cutover task replaces them.
- [x] Run baseline targeted tests, lint/typecheck/build; record results and baseline statuses. Commit `docs/audit: map W3 payment integration and golden baseline`.

Task1 evidence: `docs/W3_CAPSTONE_AUDIT.md`. Existing GREEN baseline (không tạo RED giả), không thay production; focused 118 PASS, isolated PostgreSQL 40 PASS, full unit 4071 PASS/98 skipped, lint/typecheck/build/context/diff PASS. Task2–5 chưa bắt đầu.

### Task 2: Enable positive-fee operational W3 delivery after two consents

**Files:**
- Modify: `src/modules/part-requests/delivery-operations.service.ts`, `src/modules/part-requests/delivery-operations.controller.ts` if needed.
- Modify/add tests: `src/modules/part-requests/warehouse-delivery-physical.e2e-spec.ts` or actual existing matching test paths, `src/modules/part-requests/delivery-consent.policy.spec.ts` as appropriate.
- Additive DB migration only if source/terms-to-physical binding requires it.

**Interfaces:** `approved W3 actual per request` derived server-side from canonical `delivery_fee_terms` head with verified approved cost, both consents, actual<=source/quote and physical status.

- [x] Test RED: quote dương within Admin cap → dual consent customer/tech → actual → stock RESERVE/ISSUE/DISPATCH/RECEIPT; prior zero-fee path unchanged; missing/expired consent reject; replay and CAS safe.
- [x] Use 0010 `/delivery/terms` as monetary authority; physical journal 0005/warehouse stocks as physical authority. Never make two independent chargeable fee sources or accept client verdict.
- [x] Replace `FINANCE_LEDGER_SOURCE_REQUIRED` solely for W3 verified positive path; validate source under order lock, budget L-C-Σt, cap applies only NEW quote/revision; enforce source/quote/actual/evidence matching, snapshots.
- [x] Run positive/zero/race/legacy focused tests. Commit isolated Task 2 change.

Task2 evidence: migration 0014 + canonical terms physical/stock; service/PG RED→GREEN, PostgreSQL physical 54 PASS, full unit 4072 PASS/98 skipped, focused 118 PASS. Invoice/payment remain closed. DEV gate still rejects pending 0014; rollout/schema proof belongs to Task5. No shared DB/push/deploy.

### Task 3: Freeze W3 invoice 70/30 and narrowly enable collection

**Files:**
- Modify: `src/modules/service-orders/service-orders.service.ts`, `src/modules/finance/invoice-shipping-snapshot.ts`, `src/modules/finance/finance.service.ts`, `src/modules/wallet/settlement.service.ts`.
- Add: `src/database/migrations/<next>-W3InvoicePaymentEnable.ts` (forward-only), tests including `src/modules/finance/w3-cutover.spec.ts` and `src/database/w3-dev-release.postgres.spec.ts`.
- Review consumers: `src/modules/finance/visit-charge.ts`, voucher funding/refund, `src/modules/wallet/custody-settlement.ts`.

**Interfaces:** Immutable invoice shipping snapshot `shippingPolicyVersion, shippingFee, customerShippingShare, technicianShippingShare`, derived from actual per-shipment records. Do not rewrite historical invoices.

- [ ] Test RED: 200k/20k/30k invoice gross=221k W3 and cash wallet debit=50k; online settlement wallet credit=171k; no-ship legacy unchanged; 2 shipment rounding; DB CHECK W3 accept.
- [ ] Replace unconditional LEGACY snapshot only for new fully verified W3 deliveries, with strict refund/consent/physical eligibility. If no W3, keep legacy; never silently roll back an incomplete W3 to 100/0 after customer agreed 70/30.
- [ ] New migration drops specific closed CHECK and revises W3 share CHECK for sum per shipment (without weakening legacy). Persist/verify immutable per-shipment breakdown or use immutable 0010 source with rigor; ensure invoice create and source verification transactional.
- [ ] Read W3 invoice snapshot rigorously; implement strict narrow W3 guard at all payment entry points, including group/voucher or deliberately explicit unsupported subpaths with clear user-facing messages. Avoid global bypass and wire existing settlement posting once.
- [ ] Run PostgreSQL, full finance/legacy/W3 tests and CI. Commit.

### Task 4: Direct manual transfer receipt, refund and Admin configuration

**Files:** `src/modules/finance/*` (new small Admin-only confirmation controller/service), additive payment receipt migration only if existing payment attempts cannot model verified manual transfer safely; `src/modules/system-config/*` only for clarifying cap semantics; tests.

**Interfaces:** Bank transfer to group's account is an EXTERNAL action; authorized Admin can mark it received only after checking reference+exact amount. Same existing `markInvoicePaidOnline`/settlement once.

- [ ] Test RED: right order/amount/payer/unique receipt id; Admin confirms once; duplicate idempotent; forged customer, wrong amount or reuse receipt rejected; audit.
- [ ] Implement PENDING->CONFIRMED receipt under transaction locks and call existing invoice/settlement (no fake provider callback); keep W3/W1 checkout compatibility.
- [ ] Refund after true payment only, matching original rail and recorded confirmation; avoid fake auto bank refunds. Document manual Admin action.
- [ ] Test commission 0 and shipping 0 config; cap 0 is not automatic free delivery. Commit.

### Task 5: Web parity, CI, isolated DB and DEV UAT

**Files:** Separate Web repo PR for customer/tech/SM/Admin components + API adapter; release notes/docs in Backend repo.

- [ ] Map Web routes and current W3 policy page/terms adapter; show exactly customer 70%, technician 30%, approved version, actual, invoice, wallet posting, Admin status/fee cap/manual transfer.
- [ ] UI tests, backend unit/E2E and isolated Postgres migration upgrade+replay; CI PR success. Verify no W1/W2/PICKUP/voucher/VisitGroup regressions.
- [ ] On approval, merge incremental PR(s) into dev and verify DEV deployment/health. Only then run end-to-end QA with demo accounts, and a small real transfer if the group chooses. Never change PROD/main.

## Execution policy

First deliver **Task 1 audit/golden tests** as self-contained tested commit, then Tasks 2-3 as subsequent checked commits/PRs; do not claim real W3 payment active until Task 3 and DEV UAT pass. Use Codex implementer per independent slice and separate reviewer before merge. Stop on findings about money double posting rather than deleting guard. Owner has approved this roadmap and requested Codex execution; no further procedural signature request.
