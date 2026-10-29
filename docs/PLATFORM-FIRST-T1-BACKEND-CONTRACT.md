# Platform-first T1 — Backend contract

Baseline: `ba7586e7013528596e08b3bd311f609c63accf90` (clean before edits).
Authority: owner-approved `FIXHOME_PLATFORM_FIRST_APPROVED_EXECUTION_PLAN_20261029.md`,
D1–D6 and `BUSINESS-BASELINE.md` v3.6. This implements the permitted **verified
interruption record fallback**. It does not establish the complete platform-first release.

## Existing contracts inspected

| Path / source | Contract retained |
| --- | --- |
| `ServiceOrderStateMachine` | `accepted -> en_route -> under_repair -> completed`; cancellation from nonterminal states. Technician role cannot cancel onsite via normal role transitions. No new status or transition permission. |
| `ServiceOrdersService.cancelLocked` | Prearrival withdrawal releases assignment and auto-rematches SOLO/whole VisitGroup; own VALID check-in blocks technician generic cancellation. Normal terminal cleanup closes parts and cancels pending invoice payment attempts. |
| `ServiceOrdersService.reportRepairFailed`, `repair-failure-incident.ts` | Existing objective failure checks actor, approved scope, no invoice, part disposition and private evidence; cancels affected device to zero with strict receipt, without points. Received custody persists. Unchanged business flow. |
| `TechnicianReportService.report/decide` | Informational typed report creates case; only a later explicit SM/Admin responsibility decision may deduct points. |
| `TechnicianAssignmentService.interruptionOptions/resolveInterruption` | Approved quotation/additional cost, invoice, payment, voucher and parts block direct reassignment/close. Those guards remain intact. |
| `QuotationsService` / completion / invoices | Approved scope is historical; invoice is frozen. New invoice uses approved actual-use evidence; completed child is charged by one parent checkout. No quote, price, invoice or ledger rewrite. |
| `FinanceService.markInvoicePaidOnline/applyConfirmedCash` | Verified old money may still arrive; completion consults `isCompletionHeld`. The receipt now holds completion independently of case status, without changing provider verification, cash collection, invoice PAID or settlement formulas. |
| `repair-failure-draft.ts`, `interruption-draft.ts`, confirmed rebook | Failure draft uses strict objective-failure receipt. Existing interruption draft requires cancelled source and resolved manager case. Draft reads create nothing; confirmation reprices/schedules and links sources. Neither existing confirm accepts the new receipt in T1. |
| `RepairFailureVoucherEvidence.failure` | Requires cancelled booking/order plus strict objective failure receipt and canonical SOLO/group ownership. New technician interruption case is not silently treated as that source. |
| `PartCustodyService.command`, custody policy/rules | Technician declares on original custody ownership, not active assignment. SM alone accepts positive actual quantities or discrepancy with version/idempotency; declaration is not receipt. Tracking and finance modes stay separate. Legacy non-enrolled parts do not prove zero owed. |

## Additive API

All routes retain `/api/v1`, existing envelope/filter and JWT + RBAC + permission guards.

* Existing `POST /support/cases/technician-report` accepts optional `intent: REPORT_ONLY`;
  omission retains old clients. Other intents are rejected. It never changes service outcome,
  issues a voucher or deducts points. Existing report/evidence-ref semantics are retained.
* New `POST /service-orders/:id/cannot-continue` (200), only TECHNICIAN with
  `order:read_related`. Body: UUID-v4 `commandId`, existing typed `reasonClass` and
  `reasonCode`, trimmed 10–2000-character `reason`, optional `photoEvidenceIds` (0–3
  unique UUID-v4 IDs). `customer_absent` and `customer_cancelled` belong to other
  workflows and are denied. Objective impossible-device reporting remains on
  `/repair-failed`; the new route does not infer objective failure or voucher entitlement.
* New `GET /service-orders/:id/customer-continuation` (200, `Cache-Control: no-store`),
  only the source CUSTOMER with `order:read_related`. Other actors/owners are denied.

POST and successful-source GET return:

```json
{
  "version": 1,
  "incidentId": "<support-case UUID>",
  "serviceOutcome": "VERIFIED_INTERRUPTION_RECORDED",
  "serviceOrderStatus": "<unchanged en_route or under_repair>",
  "terminalTransitionApplied": false,
  "oldObligations": {
    "reviewRequired": true,
    "quotePreserved": true,
    "moneyPreserved": true,
    "partsPreserved": true,
    "physicalReturnAcceptance": "MANUAL_SERVICE_MANAGER_ONLY",
    "legacyPartReturnState": "NOT_VERIFIED"
  },
  "customerContinuation": {
    "eligible": true,
    "independentNewBookingAllowed": true,
    "prefilledRebookAvailable": false,
    "requiresNewSchedule": true,
    "requiresPricingRevalidation": true,
    "requiresCustomerConfirmation": true,
    "source": {
      "serviceOrderId": "<source UUID>", "bookingId": "<source UUID>",
      "incidentId": "<support-case UUID>", "visitGroupId": null
    }
  }
}
```

For an owned source without valid receipt, GET returns null incident/outcome/source,
`reviewRequired:false` and continuation eligibility false. This means no verified
continuation source; it does not disable the ordinary create-booking API. Flags describe
source eligibility, not a waiver of account, pricing, availability or final booking validation.
No amounts, private evidence URLs, provider references or old technician IDs are returned.
No Booking, VisitGroup, invitation, quotation, payment, voucher or return is created by either route.

## Command / source authority and race handling

* Authenticate current own active assignment before locks; recheck exactly one active
  assignment under order/assignment locks. Require own VALID check-in after the current
  assignment, with finite timestamps not in the future. Stage must be `en_route` or
  `under_repair`; booking must be `matched`; group item must still have no outcome.
* Lock existing group hierarchy: lead booking -> VisitGroup -> affected booking ->
  ServiceOrder -> active assignment. SOLO locks booking -> order -> assignment.
  Receipt and notifications use the same transaction. A receipt/notification error aborts it.
* `SupportCase.interruptionCommandId` and its existing unique index reserve the command
  globally; canonical SHA-256 binds order, actor, UUID, typed reason and sorted evidence IDs.
  UUID casing, surrounding reason whitespace and JSONB object-key order do not change replay.
  Same command/actor/payload returns the same incident without repeated side effects.
  Different key/payload, reassignment, duplicate/malformed receipt or conflicting outcome fails closed.
* Strict audit action `TECHNICIAN_CANNOT_CONTINUE_ONSITE`, resource `service_order`,
  version 1, binds the case, booking/customer/group, assignment, VALID check-in and request.
  Receipt verification follows the existing strict failure-proof pattern, independently
  of SM case OPEN/IN_REVIEW/RESOLVED/REJECTED status. Raw case prose grants no eligibility.
* Receipt existence prevents a second progress/quote decision/objective failure through
  locked command authorization and central transition checks. Automatic completion uses
  the existing completion-hold gate even after SM removes the case hold or closes it.
  Manager reassignment/close paths remain denied. A malformed receipt blocks mutation but
  grants no customer source. No new responsibility event or voucher dispatch occurs.
* Customer + active SM/Admin receive transactional REST notices referencing SUPPORT_CASE;
  text makes no promise of cancellation, refund, zero amount or physical return acceptance.

## Exact terminal-transition BLOCKER and remaining T2/T3

**BLOCKER:** existing generic cancellation performs cleanup that may close parts or
pending payment attempts; manager interruption guards intentionally reject approved
scope/money/parts; current technician role has no onsite cancellation transition.
No safe general terminal transition retaining all those obligations has been proven.
T1 therefore applies the separated-record fallback to every new cannot-continue command,
including clean orders. It never changes `ServiceOrder.status`, totals, Booking status,
assignment, group outcome, original quotation, invoice, payment, voucher or custody.
The case is urgent with an initial completion hold, while immutable receipt authority is
independent of that mutable hold. This is not a claim that the old service is CANCELLED.

T2 must provide a reviewed terminal service disposition / historical approved quote
contract, consume this verified source in draft + confirm, and enforce failed/stopped-only
selection: one child -> SOLO, two/three -> new VisitGroup. Revalidate new time/prices,
exclude prior technician, persist source consumption/replay, and never transfer money or
discount. D3 policy-based one-per-SOLO/group skill-gap compensation needs its own verified
failure adapter; current interruption receipt alone does not dispatch compensation.

T3 must verify return access after eventual deassignment/terminal transition, physical
partial receipt/discrepancy and legacy/manual review. T1 keeps assignment to preserve old
financial/custody identity; old busy scheduling, group checkout and old money reconciliation
can remain pending until the reviewed terminal contract. Parent checkout and sibling outcomes
are not recomputed or bypassed. No automatic return acceptance or cleanup is permissible.

## Verification / release boundary

New focused tests exercise real services and proof helpers with an in-memory transaction
double: denied actors, check-in/stage, malformed/private evidence, replay/canonicalization,
competing commands, immutable paid/quote/parts/group records, source tampering, independent
SM status, second-outcome guards and rollback injection. Existing failure, rebook, voucher,
custody and manager regression suites must also remain green. A serialized double is not
PostgreSQL race proof. No new schema, dependency or environment variable is introduced;
the already-reviewed interruption and typed-report schemas/indexes must already exist.

PostgreSQL concurrency/unique-index/RLS/rollback, actual VNPay/wallet/cash callbacks,
HTTP/JWT runtime, Docker `/health`, authenticated DEV E2E and Web/Mobile parity:
**NOT VERIFIED**. No shared DB, migration, deployment, flags, Mobile or AI changes.
Restart backend after later authorized integration before runtime QA. T2/T3 and independent
financial/parts review remain release requirements; no production approval is implied.

Local evidence: 50 new focused tests PASS; selected 11-file regression run 206 tests PASS;
full `npm test -- --maxWorkers=4` 242 files / 2455 tests PASS, 3 files / 21 tests skipped.
`npm run typecheck`, `npm run lint` (0 errors, 2 unrelated existing warnings),
`npm run build` and `git diff --check` PASS. The fixture-only strengthening of the
second-outcome test was subsequently rerun: all 50 focused tests PASS.

Self-review (not independent financial approval): BA/PM — fallback and remaining T2/T3
explicit; CTO — existing Nest module and receipt/lock patterns, no state-machine expansion;
Senior Developer — no financial/custody writes or duplicate failure engine; Security —
JWT/RBAC, own assignment/check-in, private evidence and strict replay/source proof;
Tester/QA — negative/tamper/replay/rollback and regression evidence above; DevOps — no
dependency, schema, environment or runtime action. Read-only Web source still sends the
generic replacement support case and tells the technician to wait for management;
new route integration and Web/Mobile rendered parity remain NOT VERIFIED.
