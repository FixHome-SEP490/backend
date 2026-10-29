# T8 — Safe operational stop (local source only)

Base: `ad90d7f`. Decision: [T7 ADR](PLATFORM-FIRST-SAFE-EXIT-ADR.md).

Done:
- The existing cannot-continue command atomically writes the immutable T1 receipt,
  releases the original assignment and appends one versioned finalization audit.
  Same fingerprint replays; a different command conflicts. Historical T1 remains
  readable; exact original replay finalizes it once without duplicate notices.
- Only the affected VisitGroup item becomes `interrupted`, with `IS NULL` and
  exactly-one-row guards. Siblings, old Booking/Order status and totals are kept.
- Source proof binds both audits, original actor/assignment/check-in, scope,
  fingerprint and release timestamp. Inactive historical assignments work for T2
  draft/confirm; malformed/duplicate proofs fail closed. Case prose is not authority.
- Continuation, customer order detail and restricted technician history expose
  `workStopped` / `operationalDisposition: STOPPED`; continuation also exposes
  `assignmentReleased`. Existing response version/outcome/status stay compatible;
  `terminalTransitionApplied:false` means no ServiceOrder enum transition occurred.
- Active-assignment authorization prevents new quote/additional cost/completion.
  Custody declaration remains original-custodian scoped; SM alone accepts physical
  returns. No return acceptance, sanction, voucher, refund or zero invoice is inferred.
- Paid sweep SQL excludes interruption/finalization audit sources. The existing
  transactional completion hold still blocks progress after case closure.
- Group checkout removes stopped work from operational waiting. With an old invoice,
  it preserves invoice amount/paid truth and pre-stop allocation eligibility, and
  holds NEW checkout (`ready:false`, `paid:false`, `financialFollowupRequired:true`).
  No-invoice interrupted children permit the single checkout for successful siblings.
  Existing allocation equality is retained for legacy callbacks; no provider record
  is rewritten by STOP.

Preserved: approved quotations, invoices, payment attempts, Cash First/legacy,
wallet, voucher/F4 funding, PlatformDue, received requests and custody quantities.
No dependency, schema, migration, environment or feature-flag change.

Verification:
- PASS — `npx vitest run src/modules/support-cases/onsite-interruption.spec.ts src/modules/bookings/onsite-interruption-rebook.spec.ts src/modules/finance/visit-charge.spec.ts`: 3 files, 115 tests.
- PASS — `npm run typecheck`.
- PASS — `git diff --check`. Fault-injection
  tests intentionally emit strict audit errors and verify rollback.
- NOT VERIFIED — PostgreSQL locks/races/RLS and actual sweep SQL execution;
  shared DEV, Docker/health, provider callbacks including funded rails, JWT/browser
  runtime, Web/Mobile consumers, full regression, build, CI and owner E2E.

Deferred: T9 old-money reconciliation and verified zero-charge disposition; T10 D3
compensation. Existing financial exceptions stay untouched. A group with a stopped
invoice remains held for T9; customer independent source rebook still works.
No claim of complete platform release or finance/provider acceptance.

Review: Nest service/entity boundaries, RBAC/ownership, strict replay/source proof,
conditional release/outcome writes, rollback and financial/custody conservation
reviewed locally by the sole writer. Independent review is NOT VERIFIED.

No push, PR, merge, deploy or shared data access. Before later authorized runtime QA,
restart the backend. Rollback must preserve stop guards/readers for finalized audit
rows; never delete receipts or reactivate old assignments automatically.
