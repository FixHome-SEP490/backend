# DEV1 current code gap — 2026-09-15

Baseline: user-supplied MASTER v1.4 and DEV1 IMPLEMENTATION PLAN. Audit precedes fixes.
Existing uncommitted Backend/Web edits were present at task start and are preserved.

## Conflict notes

- MASTER 8.9 and DEV1 3.5 create ServiceOrder only at ACCEPTED. Pending Confirmation is a Booking/matching UI milestone. Legacy technical guides still describe the earlier lifecycle; do not restore early order creation.
- MASTER 8.6 requires Booking-bound chat, while older delta/TBD sections mention pre-booking contact. Use the restrictive Booking-bound rule; no free chat.
- Existing lowercase wire enums remain stable (verification `approved` means verified); labels may be uppercase.
- Mobile is currently a mock prototype, not an implemented DEV1 client. Web has real endpoints mixed with mock failure fallbacks.

## Pre-fix audit

| Priority | Module/Task | Status | Vấn đề | Cách sửa |
| --- | --- | --- | --- | --- |
| P0 | Ownership/RBAC | PLANNED | Global order list and nested history/invoice/quote/cash reads leak across accounts; En Route and additional costs lack ownership | Enforce resource access and command actor in services; restrict operations lists |
| P0 | Matching/Accept | PLANNED | Missing schedule, time off, area and assignment filters; stale invitation object used after lock; decline/next race | Shared eligibility and transactional Booking/User locking; reload invitation; sequential expiry/retry |
| P0 | Completion/state | PLANNED | Legacy complete bypasses payment/customer; transitions bypass machine; inspection can start without approved quote | Central locked transitions and shared preconditions |
| P0 | Arrival | PLANNED | distanceMeters=0; no geofence calculation | Haversine from immutable address snapshot and accuracy checks |
| P0 | Payment | PLANNED | Demo invoice/due endpoints mark PAID; cash requires COMPLETED before payment | Reject fake online success; dual cash confirmation before final completion |
| P0 | Migration | PLANNED | Adds and uses PostgreSQL enum in same transaction; potential duplicate columns | Validate fresh migration/revert/reapply and fix migration errors |
| P1 | Booking/rebook | PLANNED | Interfaces bypass ValidationPipe; optional time/address; wrong rebook price | Runtime DTOs, snapshot validation, explicit new time selection |
| P1 | Quote/parts | PLANNED | No arrival/state; non-idempotent decision; arbitrary FixHome part price | Lock decisions, validate types/warranty, consume catalog authority or reject unavailable catalog integration |
| P1 | Cancellation/history | PLANNED | Auto strikes/boost; no Booking cancel/reselection; history omits cancellations | Audited cancellation without automatic penalties; recovery and historical read model |
| P1 | Web | PLANNED | Mock success on API failure, wrong start route, mismatched wire enums/payload | Real API results and explicit error/loading states; synchronized DTOs |
| P1 | Mobile/media/realtime | BLOCKED | Mobile mock auth/workflow; private storage and notification modules are scaffolds | Report dependency honestly; never fake evidence/payment/demo success |
| P2 | Test/UX | PLANNED | No DEV1 business/IDOR/concurrency regression | Add meaningful service and HTTP/PostgreSQL regressions, client contract tests |

## DEV2 dependencies

Auth/permissions, verified profile and technician availability data, service catalog/config,
Part Catalog, private Supabase Storage, verified online invoice/PlatformDue provider,
Manager support resolution and notification transport. Do not duplicate these authorities.
The current code places cash/invoice handlers inside service-orders; security fixes there
must preserve route names and document tightened behavior for DEV2 consumers.
