# T9 — Read-only finance disposition / new collection guard

Base: `e109812`. Backend only; no migration, dependency, flag or ledger change.

Done:
- Order detail/list adds `failedWorkFinance` for durable T1/T8 interruption sources.
  Strict T8 final proof plus absence of all inspected exposure yields
  `VERIFIED_WORK_STOPPED_UNBILLED`; otherwise `FINANCIAL_REVIEW_REQUIRED`.
  Both return `customerPayableVnd:null`, `refundState:NOT_DETERMINED`,
  `newCollectionAllowed:false`, historical-quote labeling and pending reconciliation.
  Original grandTotal/quotation/payment status remain historical and unchanged.
- `GET /service-orders/:id/stopped-work-finance` is JWT + SM/Admin + permission
  guarded, including a service-level role check. It returns reason codes and
  allowlisted old-record IDs/states only. Customers get no internal evidence;
  former technicians retain the existing restricted history. No provider refs,
  notes, tokens, cash evidence URLs or customer IDs are added to this model.
- Reads inspect Invoice/Payment attempts, legacy CashSettlement, Cash First,
  VisitGroupPayment, voucher source/reservation claims, payment links/funding,
  PartRequest and PartCustody. Any part request conservatively requires review;
  no received/used/returned quantity or physical acceptance is inferred.
  Missing schema/read errors mean `EVIDENCE_UNAVAILABLE`, never absence of money.
  Group-scope evidence is conservatively shared in the informational model.
- New solo wallet/VNPay/generic payment/cash and funded initiation are guarded
  by durable interruption existence, including malformed proof (fail closed).
  Cash First creation is explicitly guarded for both scopes. Group initiation
  passes `VISIT_GROUP` and reuses `loadVisitCharge(...,true)` under its existing
  group lock: stopped child with old unpaid/paid invoice holds collection;
  no-invoice stopped child still allows successful-sibling-only checkout.
  No guard is added to existing cash confirmations/receipt reconciliation,
  provider callbacks, shared voucher quote or historical no-charge integrity.
  Their original domain guards remain; T9 does not guarantee they accept every
  pre-STOP case. T8 paid sweep/completion hold and frozen allocations remain.

Exact blocker / deferred T9b:
- T8 proves `VERIFIED_INTERRUPTION_RECORDED` and STOP, not an independently
  verified genuine failed repair. Skill-gap prose/reason and zero invoice count
  cannot authorize 2A zero labor/parts or D3. No synthetic 0 is exposed, even
  in the unbilled state. A strict genuine-failure authority is still required.
- Paid/pending/overpayment, voucher subsidy/quota, used parts liability, tax,
  commission/PlatformDue and refund destination/amount need authorized finance
  decisions and existing domain commands. No cancel/refund/release/redeem/wallet
  credit, part acceptance or parallel settlement implementation is added.
- The read model is informational, not an atomic financial snapshot or mutation
  authority. New collection decisions use transactional domain guards, not this DTO.
- T10 D3 and Web/Mobile rendering/contract adoption remain separate.

PASS: four focused specs, 116/116 tests: `onsite-interruption.spec.ts`,
`voucher-collection-exclusion.spec.ts`, `visit-charge.spec.ts`,
`test/context-doc.spec.ts`. PASS: `npm run typecheck` and `git diff --check`. New behavior was
observed RED before implementation; financial tests use persistence doubles.
Intentional audit-failure
tests emit error logs; Vite emits the existing CommonJS config warning.

NOT VERIFIED: PostgreSQL/locks/races, provider callbacks, shared DEV, Docker/health,
authenticated/browser runtime, Web/Mobile parity, full regression, lint/build,
E2E and CI. No push/PR/merge/deploy. Restart backend before later authorized QA.
