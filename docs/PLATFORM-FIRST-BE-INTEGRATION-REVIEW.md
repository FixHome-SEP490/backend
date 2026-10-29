# Platform-first Backend integration review (T2 + T3b)

Date: 2026-10-29 (UTC+7). Isolated Backend worktree only. No push, no PR, no shared DEV, no
deployment, no shared database migration, no Docker container changes.

## Sources and merged commits

| Item | Commit / branch |
| --- | --- |
| Integration branch | `foxonworld/fixhome-platform-first-backend-integration-20261029` |
| T2 source (parent 1) | `81627d44325cf5f1b0e88de6363e9b58a1563674` on `foxonworld/fixhome-platform-first-backend-t1-20261029` |
| T3b source (parent 2) | `01ab9ccfb7fad82f7c9a17c891afb5ad3d7150c6` on `foxonworld/fixhome-platform-first-parts-t3-20261029` |
| T3b audit commit included | `827cdaf226dd6c0015b03ab2ffad4aa2886e0ca5` |
| Common base | `6ed7f73ddba4a0279b919b4755a067e3c26e25e7` |

The local merge uses `git merge --no-ff` and this document. T2 adds verified onsite interruption
continuation through customer rebook. T3b adds the SM-only, read-only legacy manual-review GET and
its audit tests. No business implementation was added during integration.

## Conflict resolution

Only `docs/CONTEXT.md` conflicted. Both T2 and T3b section 3, 5, 8 and 9 entries were preserved;
the representative T1 sentence was reconciled to say prefill/confirm belongs to T2 and final
reconciliation to T3. The header and newest log line use the integration branch. The log keeps 40
entries newest-first, and the context schema, section order and 700-line limit are unchanged.
No conflict was resolved by blindly taking ours or theirs.

## Review of merged behavior

- Quote lock ordering: T2 `REJECT` resolves the order identity, then locks the Booking lead,
  VisitGroup and Booking before locking the Order. This matches cannot-continue/rebook and removes
  the Order-to-Booking inversion that could deadlock.
- Source eligibility: a draft/confirm source must be the customer's real interrupted source with a
  strict onsite receipt or the existing manager-close receipt. Open siblings stay out of the
  source set; completed/failed siblings keep their own outcome APIs; consumed sources are excluded;
  group sources are re-checked under lock.
- Rebook status: confirmation creates a new SOLO Booking or a new VisitGroup only. It does not
  accept work, complete, cancel or terminalize the old order, and it does not deassign the old
  technician. Old assignment, schedule, approved quote, invoice, money, voucher and parts remain.
- SM-only parts endpoints: `GET /api/v1/part-returns/legacy-manual-review` requires
  `service_manager`, is read-only and paginated, and returns `receiptState: UNKNOWN` without
  accepted/declared/outstanding/used quantities. The anti-join uses the PartCustody item key; no
  legacy row is backfilled and `accept-return` cannot turn an unknown row into a receipt.
- Hard locks retained: existing transition, ownership, idempotency/version, source-consumption,
  manager-action and parts-custody guards are unchanged. The full suite and the T2 PostgreSQL
  transaction test both pass.

## Verification executed

| Check | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | PASS, lock file not edited |
| Focused Vitest: `onsite-interruption-rebook.spec.ts`, `platform-first-parts-audit.spec.ts`, `test/context-doc.spec.ts` | PASS, 56 tests |
| `npm test` | PASS, 244 files passed / 3 skipped; 2509 tests passed / 21 skipped |
| T2 isolated PostgreSQL e2e (`onsite-interruption-rebook.pg.e2e-spec.ts`) | PASS, 6 tests; container label `fixhome.task=platform-first-t2-20261029`, database `fixhome_t2_onsite`, no shared data |
| `npm run lint` | PASS, 0 errors, 3 pre-existing warnings |
| `npm run typecheck` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

The PostgreSQL run used only the existing dedicated local container verified by its label, database
name and isolated schema. No unrelated container was started, stopped or altered, and no shared
database was contacted.

## Remaining release blockers

- The old interrupted order and assignment remain active/busy: this integration does not implement
  a safe terminal transition or deassign for an approved quote, money or parts.
- D3 voucher is not implemented; the interruption receipt is not proof of technician skill failure
  or a zero-charge outcome.
- Web has no legacy unknown-return queue, so T3 AT10 is not complete even though the Backend
  read-only endpoint exists. Consumer context and Web/Mobile runtime are NOT VERIFIED.
- Authenticated HTTP/JWT IDOR, shared-DEV lock/index/RLS behavior, Docker `/health`, pushed CI and
  end-to-end owner acceptance remain NOT VERIFIED. The isolated PostgreSQL result does not replace
  those gates.
