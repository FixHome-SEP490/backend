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
  /**
   * What the conversation established beyond the symptom, from the AI's
   * notesVi: what the customer already tried or ruled out, what they suspect.
   * Optional: summaries recorded before it existed have none.
   */
  notes?: string[];
  /** What the customer said about the answers, for the team to learn from. Never copied to a booking. */
  feedback?: AiFeedbackEntry[];
}

export type AiFeedbackVerdict = 'wrong' | 'right';

export interface AiFeedbackEntry {
  at: string;
  verdict: AiFeedbackVerdict;
  /** What the customer added, if anything. */
  note: string | null;
  /** The reply the verdict is about, as the customer saw it. */
  reply: string | null;
  /** Which turn of the conversation it came after. */
  turn: number;
}

/** Kept per session; the oldest go first. */
export const AI_FEEDBACK_LIMITS = { entries: 20, note: 300, reply: 1000 } as const;

/** The copy frozen onto a Booking when it is created from an AI conversation. */
export interface AiBookingSummary extends Omit<AiChatSummaryState, 'turnCount' | 'feedback'> {
  recordedAt: string;
}

export interface AiTurnInput {
  /** What the customer typed this turn (question or description). */
  text?: string | null;
  photoCount?: number;
}

/** What the AI Service accepts in `history`: at most this many turns, each this long. */
export const AI_HISTORY_LIMITS = { turns: 20, chars: 2000 } as const;

export const AI_SUMMARY_LIMITS = {
  customerText: 1000,
  conclusion: 600,
  item: 200,
  items: 3,
  notes: 6,
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
    notes: [],
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

  // Replaced, not appended: the AI sends the whole picture every turn, and a
  // fault the customer brought back ("à nhầm, chưa vệ sinh") must drop out.
  if (Array.isArray(reply.notesVi)) {
    next.notes = (reply.notesVi as unknown[])
      .map((note) => clean(note, AI_SUMMARY_LIMITS.item))
      .filter((note): note is string => !!note)
      .slice(0, AI_SUMMARY_LIMITS.notes);
  }

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

/**
 * The customer's earlier messages, oldest first, recovered from the summary.
 *
 * Sent to the AI Service as `history` so it can rebuild a conversation it no
 * longer holds - it restarted, or the session sat idle past the hour - instead
 * of answering "vậy giờ là bị gì" as if it were the first message. Built only
 * from what this server recorded, never from anything a client sends.
 */
export function historyFromSummary(summary: Pick<AiChatSummaryState, 'customerText'> | null | undefined): string[] {
  const text = summary?.customerText;
  if (!text) return [];
  return text
    .replace(/^…/, '')
    .split(' / ')
    .map((turn) => turn.trim())
    .filter((turn) => turn.length > 0)
    .map((turn) => turn.slice(0, AI_HISTORY_LIMITS.chars))
    .slice(-AI_HISTORY_LIMITS.turns);
}

/** Append one verdict to the summary, keeping the newest AI_FEEDBACK_LIMITS.entries. */
export function addFeedback(
  previous: AiChatSummaryState,
  verdict: AiFeedbackVerdict,
  note: string | null | undefined,
  reply: string | null | undefined,
  now = new Date(),
): AiChatSummaryState {
  const entry: AiFeedbackEntry = {
    at: now.toISOString(),
    verdict,
    note: clean(note, AI_FEEDBACK_LIMITS.note),
    reply: clean(reply, AI_FEEDBACK_LIMITS.reply),
    turn: previous.turnCount,
  };
  const feedback = [...(previous.feedback ?? []), entry].slice(-AI_FEEDBACK_LIMITS.entries);
  return { ...previous, feedback };
}

/** True when the conversation produced something worth telling the technician. */
export function hasAdvice(summary: AiChatSummaryState | AiBookingSummary): boolean {
  return !!(
    summary.deviceName ||
    summary.suspectedFaults.length ||
    summary.conclusion ||
    summary.priceMin != null ||
    summary.notes?.length
  );
}

export function toBookingSummary(state: AiChatSummaryState, now = new Date()): AiBookingSummary {
  // turnCount stays with the session; the booking keeps only what was learned.
  const { turnCount: _turns, feedback: _feedback, ...summary } = state;
  void _turns;
  void _feedback;
  return { ...summary, recordedAt: now.toISOString() };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * "The last n days" for the admin, in Vietnam: from midnight n-1 days ago to
 * now, so 7 days is today and the six before it - seven rows, whatever the
 * server's or the database's time zone.
 */
export function vnDaysWindowStart(days: number, now = Date.now()): Date {
  const todayStart = Math.floor((now + VN_OFFSET_MS) / DAY_MS) * DAY_MS - VN_OFFSET_MS;
  return new Date(todayStart - (Math.max(1, Math.floor(days)) - 1) * DAY_MS);
}
