/**
 * The three groups of the technician's "Linh kiện cần trả" page (BUG DETECTOR 302, PO):
 * need_declare = outstanding (still held, usage maybe not recorded yet);
 * awaiting_manager = declared or partially_received (declared, manager has not received it all);
 * completed = nothing left to return (not_required: all used, received: manager received it all).
 * exception (a reported mismatch) belongs to none of them and is only listed under "all".
 */
export const MY_RETURN_GROUPS = ['need_declare', 'awaiting_manager', 'completed'] as const;
export type MyReturnGroup = (typeof MY_RETURN_GROUPS)[number];
export type MyReturnGroupFilter = MyReturnGroup | 'all';

export function returnGroup(returnStatus: string): MyReturnGroup | null {
  if (returnStatus === 'outstanding') return 'need_declare';
  if (returnStatus === 'declared' || returnStatus === 'partially_received') return 'awaiting_manager';
  if (returnStatus === 'not_required' || returnStatus === 'received') return 'completed';
  return null;
}

/** SQL twin of PartCustodyService.view().returnStatus, over alias `c`. */
export const RETURN_STATUS_SQL = `(CASE
  WHEN (c.state->>'returnDueQty')::int = 0 THEN 'not_required'
  WHEN (c.state->>'outstandingQty')::int = 0 THEN 'received'
  WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.state->'events', '[]'::jsonb)) e WHERE e->>'type' = 'DISCREPANCY') THEN 'exception'
  WHEN (c.state->>'managerAcceptedQty')::int > 0 THEN 'partially_received'
  WHEN (SELECT COALESCE(SUM((d->>'quantity')::int), 0) FROM jsonb_array_elements(COALESCE(c.state->'declarations', '[]'::jsonb)) d) > 0 THEN 'declared'
  ELSE 'outstanding' END)`;

export const RETURN_GROUP_SQL = `(CASE ${RETURN_STATUS_SQL}
  WHEN 'outstanding' THEN 'need_declare'
  WHEN 'declared' THEN 'awaiting_manager' WHEN 'partially_received' THEN 'awaiting_manager'
  WHEN 'not_required' THEN 'completed' WHEN 'received' THEN 'completed'
  ELSE 'exception' END)`;
