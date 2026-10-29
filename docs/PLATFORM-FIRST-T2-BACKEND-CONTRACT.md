# Platform-first T2 — Backend customer continuation contract

Baseline: `6ed7f73` (T1 verified onsite interruption) on
`foxonworld/fixhome-platform-first-backend-t1-20261029`. Authority: owner-approved
`FIXHOME_PLATFORM_FIRST_APPROVED_EXECUTION_PLAN_20261029.md` (T2, AT04–AT06, AT08) and the T1
contract `docs/PLATFORM-FIRST-T1-BACKEND-CONTRACT.md`.

T2 extends the already-reviewed T1 receipt into the existing interruption draft + confirm path. It is
additive: no new route, schema, migration, dependency or environment variable. The T1 receipt remains
the only authority; T2 does not create a second outcome engine.

## Done in T2

### 1. Source proof for the existing customer draft/confirm

* `GET /bookings/:id/interruption-draft` and `POST /bookings/:id/interruption-rebook` (existing
  routes, same JWT + `booking:read_own` guards) now accept two source kinds for the same owned
  customer:
  * a strict T1 onsite receipt (`TECHNICIAN_CANNOT_CONTINUE_ONSITE` audit action, resource
    `service_order`) re-verified on every read by `verifiedOnsiteInterruption`, independently of the
    SM case status; or
  * the pre-existing manager-close source (cancelled booking/order plus RESOLVED
    `interrupted_for_rebook` case with `interruptionCommandId`, `technicianId` and matching
    `bookingId`/customer).
* A source with any onsite audit row must pass strict proof. A damaged receipt fails closed and never
  falls back to manager case prose.
* The onsite source requires booking `matched`, quantity `1`, active service and the source case's
  technician. It does not require `ServiceOrder.status = CANCELLED`. Nothing is written as
  `CANCELLED`, zero-priced or refunded; `ServiceOrder`, `Booking`, quote, invoice, payment, voucher,
  custody and assignment stay untouched.
* Only one failed/stopped child becomes a new SOLO booking; two or three become one new VisitGroup.
  Each item is resolved independently and must be an actual source; the anchor booking must be among
  the returned sources. Open unaffected siblings, `completed`/`failed` siblings and siblings with a
  different outcome are not offered.
* A source already consumed by `InterruptionRebookSource` is omitted from the draft and rejected on
  confirm. This is separate from T1's receipt; T1 receipt replay is unaffected.
* Fresh schedule and price: confirm calls the ordinary `create`/`createGroup` with the customer's new
  address, date, slot and optional edits. Only descriptive fields (description, device label,
  variant, device attributes, photos) carry over; price, invoice, discount and payment are
  recalculated by the existing booking rules and final validation. No old technician is invited
  automatically; `InterruptionRebookSource.previousTechnicianId` feeds the existing eligibility
  exclusion in `technician-eligibility.ts`.
* Customer-only (`Role.CUSTOMER`) plus ownership checks; foreign customers and other roles are denied
  before any creation.

### 2. Customer continuation response

`GET /service-orders/:id/customer-continuation` for an owned verified source now additionally returns
`prefilledRebookAvailable: true`, `draftPath`, `confirmationPath`, `targetKind` and `sourceCount` when
the current draft is still eligible. If the source was already consumed or otherwise no longer forms
a valid draft, the T1 eligibility answer is returned unchanged (`prefilledRebookAvailable: false`);
storage or programming failures still surface. No amounts, evidence URLs, provider references or old
technician IDs are added.

### 3. Reviewer P1/P2 fixes

* **P1 completion gate (SOLO and group):** a *new* cannot-continue command on an order whose
  `completionRequestedAt` is already set is rejected `409` before any write. An exact same-command
  replay is still answered idempotently after completion was requested, so the T1 receipt stays
  replayable. The check runs after the same-command branch in
  `TechnicianReportService.cannotContinue`. Completion itself remains blocked by the existing
  completion-hold when a receipt exists.
* **P1 Booking→Order deadlock:** quotation `REJECT` (which closes the booking) now takes the same
  lock order as cannot-continue/rebook: lead booking → VisitGroup → affected booking → ServiceOrder.
  The affected booking is locked before `authorizeOrder` obtains the order lock, removing the
  Order→Booking inversion. Applies to SOLO and group paths.
* **P2 `REJECT_REQUEST` integrity:** manager `interruptionOptions` no longer advertises
  `REJECT_REQUEST` for an order with an onsite receipt, and every
  `POST /support/cases/:id/resolve-interruption` action (including `REJECT_REQUEST`) now fails `409`
  before the `interruptionCommandId` replay branch. A manager cannot rewrite or restore a second
  outcome, and a previously used command does not bypass the receipt.

### 4. Preserved behaviour

* Money, invoice, voucher, PlatformDue, commission, provider callbacks, cash-first and wallet flows
  are not modified. No refund, transfer, discount, zero invoice or ledger rewrite is introduced.
* Physical parts/custody are not accepted, closed or rewritten. Old obligations remain for separate
  SM/finance reconciliation.
* Old approved quote is historical and immutable; T2 never fabricates `CANCELLED` or `0`.
* T1 receipt, command fingerprint, evidence and notification behaviour is unchanged.
* Existing manager-close interruption draft/confirm semantics remain for that source kind.

## Deferred / blocked

* **BLOCKER — terminal service disposition and assignment release:** no general terminal transition
  or deassignment has been proven that retains approved quote, invoice, payment, voucher, parts
  custody and group checkout safely. T2 therefore keeps the T1 separated-record fallback: the old
  service/order/booking/assignment and financial/custody state remain as-is, and the customer creates
  a genuinely new booking. The old order is not `CANCELLED`. Busy scheduling, group checkout and old
  money reconciliation remain pending this reviewed contract.
* **D3 voucher deferred:** the strict T1 interruption receipt proves a technician-recorded onsite
  interruption, not objective zero-charge failure with audited skill-gap evidence. Issuing a voucher
  from the report alone would violate AT08/one-per-source policy. No voucher is issued from T2. D3
  needs its own verified failure adapter, policy configuration and one-per-SOLO/group retry proof.
* Full authenticated DEV E2E, Web/Mobile consumer integration and parity, Docker `/health` runtime,
  real provider callbacks and pushed CI are out of this task and NOT VERIFIED.
* Independent financial/parts review of the eventual terminal contract remains required.

## Verification evidence

* New focused suite `src/modules/bookings/onsite-interruption-rebook.spec.ts`: 33 tests PASS
  (draft eligibility, completion gate/replay, manager action denial, consumed sources, SM status
  independence, foreign actors, sibling/extra/mismatched sources, legacy financial/parts
  preservation, old technician exclusion, same/different confirm serialization, rollback injection,
  no voucher inference).
* Scoped regression (10 files): 157 tests PASS — onsite interruption, interruption
  draft/confirm/exclusion, repair-failure draft/rebook, technician report, manager interruption
  command, quotations.
* New PostgreSQL race suite
  `src/modules/bookings/onsite-interruption-rebook.pg.e2e-spec.ts`, 6 tests PASS against an isolated
  disposable PostgreSQL 16 instance (`fixhome_t2_onsite`, full migration chain: 84 migrations,
  90 public tables): same command → one incident/receipt; different commands → one outcome; customer
  quote rejection vs onsite stop; completion request vs onsite stop; same-key concurrent confirm;
  different-key concurrent confirm with one closed source. No `40P01`/`40P02` observed.
* Full `npm test`: 243 files / 2488 tests PASS, 3 files / 21 tests skipped. `npm run typecheck`,
  `npm run lint` (0 errors, 3 unrelated existing warnings), `npm run build`, `git diff --check`
  PASS. `test/context-doc.spec.ts` PASS.

## Release boundary

Local source change only. No push, merge, deploy, shared/DEV/Supabase database access, migration
replay or runtime action in this task. The isolated database was created for this verification and
is not production or shared DEV. Restart backend only in a later authorized integration after the
terminal-transition blocker is reviewed.
