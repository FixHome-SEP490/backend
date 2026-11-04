# W2 PICKUP contract — Backend / Web

Base `/api/v1`; JWT required. Responses use `{ data: ... }`. W2 does not change prices,
shippingFee, invoices, wallets, finance or custody flags. DELIVERY remains legacy.

## Allocation read

`GET /part-requests/:id/warehouse-allocation`: owning active technician, Service Manager,
Admin. No token/hash/idempotency fingerprint is returned. Customer is not authorized.

```json
{ "data": { "partRequestId": "uuid", "mode": "warehouse", "status": "reserved", "warehouseId": "uuid", "warehouseName": "Kho", "warehouseAddress": "Địa chỉ", "responsibleUserId": "uuid", "distanceNotVerified": true, "reviewRequired": true, "manualAssistanceReason": null, "tokenExpiresAt": null, "tokenVersion": 0, "handedOverAt": null, "receivedAt": null } }
```

Statuses: `manual_assistance | reserved | ready | handed_over | received | released`.
Unallocated historical request / DELIVERY: `{ partRequestId, mode: 'legacy', status: null }`.
Manual outcome uses mode `warehouse`, null warehouse fields, reason
`NO_SINGLE_WAREHOUSE` (including zero stock / no active assigned manager).
Request stays REQUESTED; no stock, QR or charge is created. Active SMs receive a durable
manual-assistance notification. Retry does not backfill historical requests.
The read is redacted for non-assigned SMs/Admin: operational metadata only, never QR secrets.

## Reserve

`POST /part-requests/:id/warehouse-reserve` (SM/Admin), body `{ "idempotencyKey": "uuid" }`.
Returns allocation read shape. Only a NEW PICKUP request enrolled by W2 creation can reserve;
legacy is 409. Auto-routing runs at creation for PRE_REPAIR, approved QUOTATION and ADDITIONAL
PICKUP; canonical request items determine quantities. One warehouse must have ALL SKU quantities
available; warehouses and SKU rows lock in deterministic order; no split or partial reservation.
Manual retries can succeed after real stock-in. A SM may reserve only the chosen warehouse they
currently manage; Admin can reserve, but cannot physically hand over.
No coordinates currently exist: deterministic warehouse UUID order, `distanceNotVerified: true`,
`reviewRequired: true`; Web must show “Chưa xác minh khoảng cách; quản lý cần kiểm tra”. No km/ETA.

## Prepare / rotate PICKUP QR

`POST /part-requests/:id/warehouse-qr` (current assigned active SM only), body
`{ "idempotencyKey": "uuid" }`. Requires reserved/ready allocation and active request/order.
Marks request READY, allocation ready, rotates the prior QR, expires after 15 minutes.
Response `{ data: { allocation: <read shape>, qrToken: "opaque secret or null" } }`.
SM displays the pickup QR and confirms physical handover only when ALL items are actually handed
over. Token binds request, warehouse, assigned SM, technician and version. Never log the token.
Same-key replay returns `qrToken: null` (secret is disclosed once); use a NEW key to rotate if lost.
On `handed_over`, the SAME route with a NEW key rotates ONLY the technician receipt QR (48h),
invalidates the old receipt and preserves request status, physical stock and custody. This recovers
a lost handover response or expired receipt. Web: “Tạo lại mã xác nhận nhận; mã cũ sẽ hết hiệu lực”.
Same-key retry still returns `qrToken: null`; never issue goods again for QR recovery.
If Admin changes the primary SM, only the CURRENT assigned active SM may rotate; the new token
version binds to that manager. Previous SM cannot issue, rotate or accept returns. Historical
physical handover evidence retains the original operator.

## Physical handover

`POST /part-requests/:id/warehouse-handover` (current assigned active SM only), body
`{ "qrToken": "opaque pickup token", "idempotencyKey": "uuid" }`.
Requires valid unexpired current pickup QR, active assigned technician, ready allocation.
Atomically consumes pickup token and issues every canonical quantity exactly once:
onHand -= quantity, reserved -= quantity; append-only ISSUE evidence includes SM/time/key.
Custody tracking is enrolled at this physical ISSUE, so outstanding unused units block new work
even BEFORE technician acknowledgement. This QR is an authenticated SM command, not independent
attestation of technician presence. The separate technician receipt is still required.
Returns `{ data: { allocation: <read shape>, qrToken: "opaque receipt token or null" } }`.
The returned receipt QR is DIFFERENT, lasts 48 hours and is shown to technician for acknowledgement.
Same-key replay returns redacted allocation and `qrToken: null`; stock is unchanged.
Different payload/actor using the same command key returns 409.

## Technician acknowledgement

Existing `POST /part-requests/:id/receive`, technician only, body `{ "qrToken": "receipt token" }`.
Existing PartRequest response retained. Allocated PICKUP fails before SM handover. Receipt QR
is single-use, expires and is bound to request/warehouse/SM/technician. Acknowledgement changes
allocation to received and request to RECEIVED, without another stock decrement.
Existing `/ready` and `/qr` mutations reject W2 allocations; use `/warehouse-qr`.

## Cancellation / physical return

Existing cancel paths release reserved quantity once before physical issue, with no onHand
increment. Post-issue cancel never reverses inventory; direct request cancel is rejected after
handover, while order cancellation preserves physical custody and warehouse issue history.
Order close, failed-repair and outgoing technician reassignment release under the same transaction.
Automatic lifecycle releases record a system command (null actor_user_id), never a forged staff act.

Existing `POST /part-requests/:id/items/:itemId/accept-return` remains the only physical return
acceptance: body `{ "quantity": 1, "expectedVersion": 2, "idempotencyKey": "8-128 safe chars" }`.
For W2 only the CURRENT assigned active warehouse SM can accept. Custody validation, accept
receipt and stock RETURN run in the SAME PostgreSQL transaction; replay never restocks twice,
changed payload/key is 409; used/overreturned/undeclared quantities are rejected by custody.
Technician declaration/usage alone never increments stock or proves physical return.

Physical handover FAILS CLOSED unless existing tracking-only custody is already enabled and
the order qualifies for its existing activation cohort. W2 never enables flags, changes activation
or enrolls historical orders. Missing custody activation is 409; reservation may remain reserved
until Lead resolves the rollout prerequisite or cancels it. This is an operational rollout gate.

All W2 mutations and existing receive/cancel/accept-return use `RiskLimit('warehouse-stock')`.
Errors: 400 invalid DTO/token, 403 role/ownership/warehouse, 404 missing request, 409 state,
expired/consumed token, legacy request, custody gate or command-key conflict; 429 rate limit.

## Deployment evidence

Migration `1793466000003-WarehousePartFulfillment` is additive and seeds NO stock/warehouse.
It extends `protect_part_custody()` admission with a tracking-only W2 branch requiring matching
physical ISSUE ledger, assigned SM, warehouse, original quantities and handover timestamp.
The legacy received_at branch and custody cohort/version immutability stay enforced. Historical
migration files and runtime custody flags are unchanged. Rollback refuses ANY W2 history.
Official `origin/dev` at `80fa61f` includes warranty migrations `1793466000000`–`1793466000002`;
that source mismatch is resolved. W2 stays limited to PRE_REPAIR / approved QUOTATION / ADDITIONAL
on active service orders. WARRANTY requests retain their existing claim-based READY, inspection,
receive and charging paths, including on completed orders; W2 reserve/QR/handover return 409.
ModuleRef resolves WarrantyCostService as before; warehouseFulfillment is a separate injected provider.
Merge/deploy still require GREEN CI and Lead shared-DB read-only preflight; never undo warranty history.
Writer is authorized to commit/push to the existing PR branch; Lead owns migration/merge/deploy.
Zero real DEV warehouses/stock means manual
assistance is expected, NOT operational fulfillment. Real fulfillment requires Admin-created real
warehouse + active primary SM + documented real stock-in + existing custody rollout prerequisites.
PostgreSQL concurrency, authenticated HTTP and Web runtime remain NOT VERIFIED until run.
The CI JWT harness signs using the same effective ConfigService secret as Passport, including
environment overrides. It keeps the real JwtAuthGuard; absent and incorrectly signed tokens remain 401.
