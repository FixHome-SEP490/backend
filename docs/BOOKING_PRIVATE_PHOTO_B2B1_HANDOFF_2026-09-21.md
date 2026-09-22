# Booking private photos — B2b1 handoff

Added `PrivateBookingPhotoClaimService` as an isolated helper for same-owner, unexpired,
single-use upload claims. It requires the caller's active TypeORM transaction manager, locks rows
in ascending upload ID order, and returns only `{ uploadId, mimeType, sizeBytes }` metadata.

## Not active yet

No Booking create or attach flow calls this helper. Until B2b2 uses it inside the Booking
transaction, returns private-only safe metadata, and adds the authenticated private-photo content
proxy, this helper is dormant. Existing Booking media still uses the old public media flow, so
public Booking photos remain exposed.

## Next

B2b2 must wire claims into the existing Booking transaction and allow failures to escape that
transaction so partial claims roll back. It must keep storage references out of Booking responses,
errors, and audit data, then add the authenticated private-only content proxy. This checkpoint used
mocked EntityManager tests only; PostgreSQL lock and rollback behavior remains NOT RUN.
