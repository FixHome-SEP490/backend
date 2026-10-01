// src/modules/ai-diagnosis/ai-chat-summary.ts
/**
 * What the customer and the assistant established before a booking, kept so the
 * technician who takes the job can read it in the first chat message.
 *
 * The backend records it from the AI replies it proxies, never from anything a
 * client sends, so a booking can only carry a summary of a conversation that
 * actually happened through this server. It is advisory like the replies it
 * comes from: it names what the assistant suspected, not what is wrong.
 */

export interface AiChatSummaryState {
  deviceName: string | null;
  customerText: string | null;
  suspectedFaults: string[];
  suggestedActions: string[];
  conclusion: string | null;
  priceMin: number | null;
  priceMax: number | null;
  requiresAssessment: boolean | null;
  recommendedServiceName: string | null;
  photoCount: number;
  turnCount: number;
}

/** The copy frozen onto a Booking when it is created from an AI conversation. */
export interface AiBookingSummary extends Omit<AiChatSummaryState, 'turnCount'> {
  recordedAt: string;
}

export interface AiTurnInput {
  /** What the customer typed this turn (question or description). */
  text?: string | null;
  photoCount?: number;
}

export const AI_SUMMARY_LIMITS = {
  customerText: 1000,
  conclusion: 600,
  item: 200,
  items: 3,
  name: 200,
} as const;

/** Replies that carry no advice must not overwrite what earlier turns found. */
const ADVICE_STATUSES = new Set(['ok', 'needs_clarification']);

export function emptySummary(): AiChatSummaryState {
  return {
    deviceName: null,
    customerText: null,
    suspectedFaults: [],
    suggestedActions: [],
    conclusion: null,
    priceMin: null,
    priceMax: null,
    requiresAssessment: null,
    recommendedServiceName: null,
    photoCount: 0,
    turnCount: 0,
  };
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function names(list: unknown, key: string): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => clean(typeof item === 'string' ? item : (item as Record<string, unknown>)?.[key], AI_SUMMARY_LIMITS.item))
    .filter((item): item is string => !!item)
    .slice(0, AI_SUMMARY_LIMITS.items);
}

function money(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** Keep the most recent customer words within the limit, oldest dropped first. */
function appendCustomerText(previous: string | null, next: string | null): string | null {
  if (!next) return previous;
  if (!previous) return clean(next, AI_SUMMARY_LIMITS.customerText);
  if (previous.endsWith(next)) return previous;
  const joined = `${previous} / ${next}`;
  const max = AI_SUMMARY_LIMITS.customerText;
  return joined.length > max ? `…${joined.slice(joined.length - max + 1)}` : joined;
}

/**
 * Fold one assistant turn into the running summary. Fields only move forward:
 * a later reply that says nothing about the price keeps the earlier estimate,
 * and an unavailable or off-topic reply changes nothing but the counters.
 */
export function mergeTurn(
  previous: AiChatSummaryState,
  input: AiTurnInput,
  reply: Record<string, unknown>,
): AiChatSummaryState {
  const next: AiChatSummaryState = {
    ...previous,
    suspectedFaults: [...previous.suspectedFaults],
    suggestedActions: [...previous.suggestedActions],
    customerText: appendCustomerText(previous.customerText, clean(input.text, AI_SUMMARY_LIMITS.customerText)),
    photoCount: previous.photoCount + Math.max(0, Math.min(10, Math.trunc(input.photoCount ?? 0))),
    turnCount: previous.turnCount + 1,
  };

  const status = String(reply.status ?? 'ok');
  if (!ADVICE_STATUSES.has(status)) return next;

  const device = reply.device as Record<string, unknown> | undefined;
  next.deviceName = clean(device?.nameVi, AI_SUMMARY_LIMITS.name) ?? next.deviceName;

  const faults = names(reply.suspectedFaults, 'nameVi');
  if (faults.length) next.suspectedFaults = faults;

  const actions = names(reply.suggestedActionsVi, 'text');
  if (actions.length) next.suggestedActions = actions;

  const service = Array.isArray(reply.recommendedServices) ? (reply.recommendedServices[0] as Record<string, unknown>) : undefined;
  next.recommendedServiceName = clean(service?.nameVi, AI_SUMMARY_LIMITS.name) ?? next.recommendedServiceName;

  const price = reply.priceEstimate as Record<string, unknown> | null | undefined;
  const min = money(price?.min);
  if (price && min != null) {
    const max = money(price.max);
    next.priceMin = min;
    next.priceMax = max != null && max >= min ? max : null;
    next.requiresAssessment = price.requiresAssessment === true;
  }

  // A reply that names faults is the assistant's conclusion; plain answers only
  // fill the slot until one does.
  const answer = clean(reply.messageVi ?? reply.answerVi, AI_SUMMARY_LIMITS.conclusion);
  if (answer && (faults.length || !next.conclusion)) next.conclusion = answer;

  return next;
}

/** True when the conversation produced something worth telling the technician. */
export function hasAdvice(summary: AiChatSummaryState | AiBookingSummary): boolean {
  return !!(summary.deviceName || summary.suspectedFaults.length || summary.conclusion || summary.priceMin != null);
}

export function toBookingSummary(state: AiChatSummaryState, now = new Date()): AiBookingSummary {
  // turnCount stays with the session; the booking keeps only what was learned.
  const { turnCount: _turns, ...summary } = state;
  void _turns;
  return { ...summary, recordedAt: now.toISOString() };
}
