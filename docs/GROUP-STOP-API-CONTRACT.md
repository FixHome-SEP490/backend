# Group stop / selected interruption rebook — Backend contract

Source implementation on `foxonworld/fixhome-group-stop-be-20261101`, based on `b9fcb97`.
Owner decisions: 01/11/2026, six approved group no-show/unreachable rules.
No migration, seed, shared database writes, separate server, commit or deployment in this task.
PostgreSQL concurrency, shared DEV schema/privileges, HTTP/JWT runtime, Web/Mobile runtime: **NOT VERIFIED**.

## Technician API

All paths below have prefix `/api/v1`. Existing JWT, TECHNICIAN role and
`order:read_related` permission apply, with assignment/ownership checks in the service.
Success uses the normal `{success,statusCode,message,data}` envelope.

| Method | Path | Input |
| --- | --- | --- |
| GET | `/visit-groups/:id/contact-readiness` | Query `selectedOrderId=UUID` |
| POST | `/visit-groups/:id/contact-attempt` | `{commandId,selectedOrderId,kind}` |
| POST | `/visit-groups/:id/cannot-continue` | `{commandId,selectedOrderId,reasonClass,reasonCode,reason,photoEvidenceIds?}` |

UUID command IDs are v4. Contact `kind` is `CALL_ATTEMPT` or `IN_APP_NOTIFICATION`.
No client timestamp is accepted. A call action records **attempt/intent only**, never
telephone connection. Notification inserts a real customer in-app `Notification` in the
same transaction as its audit proof. No email, SMS or push delivery is implied.

Readiness `data`:

```ts
{
  contactCount: number;
  notificationSent: boolean;
  callsSpaced: boolean;
  nextCallAt: string | null;       // earliest first-call + 300 seconds
  nextEligibleAt: string | null;   // first-call + 600 seconds; other gates still apply
  serverNow: string;
  ready: boolean;
}
```

Contact adds `{evidenceId,recordedAt,callConnectionVerified:false}`. These are durable
AuditLog rows, tied to group, customer, selected order, actor, current assignment and
valid check-in. Replaying a contact command does not add a call or another notification.
Readiness remains false until two calls span at least 300 seconds, notification exists,
and 600 seconds have passed since the first call. Changing selected order starts a
different evidence scope; keep that selection stable through contact and group report.
GET is read-only and `no-store`; it acquires business locks for a consistent decision.

Group stop accepts only `reasonClass:'non_technician_exception'` and
`reasonCode:'customer_absent'|'customer_unreachable'`. Reason is 10–2000 trimmed
characters. Optional photos are up to three distinct UUIDs, owned ADDITIONAL private
evidence of the selected order. Other children get no copied private photos.

```ts
{
  version: 1;
  groupId: string;
  commandId: string;
  stopped: Array<{
    bookingId: string; orderId: string; incidentId: string;
    workStopped: true; assignmentReleased: true;
    operationalDisposition: 'STOPPED'; financialFollowupRequired: true;
  }>;
  preserved: Array<{
    bookingId: string; orderId: string; orderStatus: string; outcome: string | null;
    disposition: 'PRESERVED'; financialFollowupRequired: boolean;
  }>;
  oldObligationsPreserved: true;
  financialFollowupRequired: true;
  automaticLiabilityApplied: false;
}
```

The selected order must be eligible. Every eligible child must have exactly one active
assignment of the reporting technician and a VALID check-in after that assignment.
Completed, cancelled, PAID, completion-requested or already outcome-bearing children
are preserved. An unfinished child with any invoice, unknown payment state, missing
assignment/check-in or conflicting prior interruption receipt refuses the whole command.
No partial success or silent skipping of an invalid unfinished child.

HTTP 409 `GROUP_CONTACT_NOT_READY`: refresh GET readiness; do not derive readiness
from local elapsed time. HTTP 409 `GROUP_FINANCE_REVIEW_REQUIRED`: SM reconciliation
is required; do not attempt a different payment/stop route to bypass it. Other
state/command conflicts use existing `CONFLICT`. Errors use the existing error envelope;
readiness is fetched separately, not embedded in the error.

One transaction locks lead Booking → VisitGroup → all Bookings (ID order) → Orders →
Assignments; no Invoice/Payment locks are acquired after Orders. Invoice existence is
read conservatively, not reconciled. Per-child command IDs are deterministic v4-shaped
IDs derived from group command + order; each child receives its own SupportCase and
strict T1/T8 receipt. One group audit stores the original command, fingerprint,
evidence IDs and complete result. One group notification per customer/active SM/Admin
is written in that transaction. Storage errors abort every child and notification.

Idempotency is scoped to group + commandId. Exact replay by the original technician
returns the stored result after assignment release; changed payload/actor is rejected.
An uncertain response must retain the same command and payload for reconciliation;
do not create a new UUID or call each child's endpoint. There is no new customer fee,
strike, refund, voucher, settlement, parts return acceptance or ServiceOrder enum change.

`POST /service-orders/:id/cannot-continue` remains device-scoped for other reasons.
It refuses both absence/unreachable reasons; informational REPORT_ONLY stays separate.

## Customer subset rebook

Existing routes and CUSTOMER ownership/permissions remain:

- `GET /bookings/:anchorId/interruption-draft?sourceBookingIds=id1,id2` selects 1–3
  sources. Omit the query to list all currently available interrupted sources.
- `POST /bookings/:anchorId/interruption-rebook` retains the existing body:
  `{idempotencyKey,addressId,date,slot,customerNote?,items:[{sourceBookingId,sourceCaseId,...edits}]}`.
  `items` is now an explicit subset, not a requirement to consume the entire draft.

The anchor must be included in the selection; choose a selected stopped booking as
anchor. Foreign, duplicate, consumed, active, completed or non-interrupted group sources
are refused. Group onsite sources require the final operational-stop proof. SM case
resolution is not required. One source creates a fresh SOLO booking; two or three
create a fresh VisitGroup. Existing source locks, fingerprints and unique booking/case
source indexes prevent double consumption. Remaining sources can be rebooked separately
using an anchor from that remaining subset and a new idempotency key.

Fresh schedule, current pricing, customer confirmation and old technician exclusion
remain in the existing create/confirm flows. No old invoice, payment, voucher or stock
custody is transferred. New bookings are not automatically paid or assigned.

## Staff API and logical incident

`GET /visit-groups/:id/stop-incidents` is `no-store`, SM/Admin + `support:read_all`.
It returns an array of logical incidents:

```ts
{
  commandId: string; recordedAt: string;
  result: GroupStopResult; // immutable original snapshot above
  contactEvidence: AuditLog[]; // selected immutable proof IDs; no phone/GPS in payload
  children: Array<{
    bookingId: string; orderId?: string; orderStatus?: string; paymentStatus?: string;
    completionRequestedAt?: string | null; outcome: string | null;
    cases: SupportCase[]; financialFollowupRequired: true;
  }>;
}[]
```

`children` reflects current state; `result` is the historical stop result.
Existing `GET /support/cases` and `/support/cases/:id` add nullable `groupIncident`:
`{groupId,commandId,incidentPath,childCaseIds,financialFollowupRequired:true}`.
Group queue rows by `(groupId,commandId)`; pagination total still counts physical
per-child cases. Expand the logical incident for its individual cases and current states.
No new resolution/finance/parts powers are granted. Existing SM operations and separate
Admin responsibility decision remain authoritative; generic resolution cannot reverse
or manufacture an operational stop.

## Verification limits / restart

Local source checks on 01/11/2026:

- **PASS** `npm run typecheck` — exit 0.
- **PASS** `npm run build` — exit 0.
- **PASS** focused `npm test` — 11 files, **192 tests passed**, zero failed/skipped.
  Group stop spec: 31 tests. The audit-error messages in failure-injection tests are expected.
- **PASS** `git diff --check`.
- Lint/full suite/DB E2E: **NOT VERIFIED**, outside the requested focused checks.

Exact focused command (executed through `rtk proxy`):

```powershell
npm test -- src/modules/support-cases/group-stop.spec.ts src/modules/support-cases/onsite-interruption.spec.ts src/modules/support-cases/technician-report.service.spec.ts src/modules/support-cases/support-cases.service.spec.ts src/modules/support-cases/support-cases-manager.spec.ts src/modules/support-cases/support-cases-contract.spec.ts src/modules/support-cases/support-cases-envelope.spec.ts src/modules/bookings/interruption-confirm.spec.ts src/modules/bookings/interruption-rebook.spec.ts src/modules/bookings/onsite-interruption-rebook.spec.ts test/context-doc.spec.ts
```

Implementation review covered existing Nest module boundaries, the six business rules,
DTO/ownership/RBAC, lock order and conservative finance handling, source uniqueness,
error/retry behavior, old obligations, notifications and cross-repository contract.
These are review perspectives of the sole Backend writer, not independent reviewers.

Focused source tests use persistence doubles, including serialized concurrent submits
and snapshot rollback. They do not prove PostgreSQL lock scheduling, RLS, triggers,
provider interactions or shared DEV availability. No DB-coupled E2E was run.
Coordinator must review the patch and arrange runtime checks on the existing DEV service.
Restart Backend after authorized integration before runtime QA. No dependency or image
contract changed. Web/Mobile consumer adoption and rendered behavior need their own QA.
