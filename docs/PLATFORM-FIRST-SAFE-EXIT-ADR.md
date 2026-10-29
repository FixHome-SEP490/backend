# T7 — Safe operational stop

Decision: preserve the immutable T1 receipt and append one versioned
`TECHNICIAN_ONSITE_STOP_FINALIZED` audit proof under the existing
lead Booking → VisitGroup → affected Booking → Order → Assignment locks.
Deactivate only the original assignment, retaining its identity and check-in;
mark only the affected group item `interrupted`. Keep Booking MATCHED and the
original Order status/totals as financial history. Expose operational STOP
separately, never CANCELLED, refunded, zero-charge or physically returned.

Generic cancellation is rejected: `commitTransition(CANCELLED)` closes received
part requests and pending payment attempts. A new enum/table is unnecessary for
this bounded scope: Order locks serialize immutable finalization audit creation.
Strict proof validates T1 fingerprint, original assignment/check-in and the final
release timestamp; historical T1 receipts without finalization remain readable.
Same command replay may finalize a historical T1 receipt once. Other commands
conflict. Mutable case prose cannot authorize a finalized source.

Active-assignment authorization already gates new technician work and eligibility.
Keep original custody authorization for returns and SM-only physical acceptance.
Completion remains held by T1 audit even if the support case is closed. Exclude
stopped orders from paid sweep selection and prevent new group charges for the
interrupted child; retain existing payment allocations/callbacks unchanged.

T9 reconciliation, zero-charge financial disposition and T10 D3 remain separate.
No ledger mutation, migration, dependency or flag change. PostgreSQL races,
provider callbacks, authenticated runtime and Web/Mobile parity are NOT VERIFIED.
Rollback must retain stop guards/proof readers while finalized rows exist; do not
reactivate assignments or delete audits to roll back.
