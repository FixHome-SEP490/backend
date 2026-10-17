// src/modules/ai-diagnosis/ai-past-jobs.ts
/**
 * A signed-in customer's earlier repairs, as the AI Service reads them
 * (`pastJobs`), so the assistant can say "ngày 03/08 anh/chị đã đặt sửa máy
 * lạnh" and the technician sees it in the notes.
 *
 * Only the customer's own bookings that a technician took, from the last year,
 * and only the service, the appliance, the day and what the assistant
 * suspected then. No address, no technician, no money: the AI does not need
 * them and the request is the one place they could leak from.
 */
import { vnParts } from '../../shared/utils/vn-time';
import type { AiBookingSummary } from './ai-chat-summary';

export interface AiPastJob {
  serviceVi: string;
  deviceVi?: string;
  faultVi?: string;
  /** Booked day in Vietnam, YYYY-MM-DD. */
  date: string;
}

/** Mirrors the AI Service contract: at most 5 jobs, fields bounded. */
export const AI_PAST_JOBS_LIMITS = { jobs: 5, service: 120, device: 80, fault: 120, days: 365 } as const;

export interface PastBookingRow {
  serviceNameSnapshot?: string | null;
  service?: { name?: string | null } | null;
  preferredStartAt?: Date | string | null;
  createdAt?: Date | string | null;
  aiSummary?: Pick<AiBookingSummary, 'deviceName' | 'suspectedFaults'> | null;
}

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max).trim() : undefined;
}

function vnDay(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  const p = vnParts(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Newest first, as given; rows with no service name or no day are skipped. */
export function pastJobsFromBookings(rows: PastBookingRow[]): AiPastJob[] {
  const jobs: AiPastJob[] = [];
  for (const row of rows) {
    const serviceVi = clean(row.serviceNameSnapshot, AI_PAST_JOBS_LIMITS.service) ?? clean(row.service?.name, AI_PAST_JOBS_LIMITS.service);
    const date = vnDay(row.preferredStartAt) ?? vnDay(row.createdAt);
    if (!serviceVi || !date) continue;
    const job: AiPastJob = { serviceVi, date };
    const deviceVi = clean(row.aiSummary?.deviceName, AI_PAST_JOBS_LIMITS.device);
    if (deviceVi) job.deviceVi = deviceVi;
    const fault = Array.isArray(row.aiSummary?.suspectedFaults) ? row.aiSummary?.suspectedFaults[0] : undefined;
    const faultVi = clean(fault, AI_PAST_JOBS_LIMITS.fault);
    if (faultVi) job.faultVi = faultVi;
    jobs.push(job);
    if (jobs.length === AI_PAST_JOBS_LIMITS.jobs) break;
  }
  return jobs;
}
