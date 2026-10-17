import { describe, expect, it } from 'vitest';
import { AI_PAST_JOBS_LIMITS, pastJobsFromBookings } from './ai-past-jobs';

describe('past jobs for the AI', () => {
  it('sends the service, appliance, Vietnam day and the old guess, nothing else', () => {
    const jobs = pastJobsFromBookings([
      {
        serviceNameSnapshot: 'Sửa điều hòa không mát / chảy nước',
        service: { name: 'Tên đã đổi' },
        // 18:30Z on 2 Aug is 01:30 on 3 Aug in Vietnam
        preferredStartAt: '2026-08-02T18:30:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
        aiSummary: { deviceName: 'Máy lạnh', suspectedFaults: ['Thiếu gas, xì gas', 'Hỏng tụ'] },
        addressTextSnapshot: '12 Lê Lợi', finalAmount: 500000,
      } as any,
    ]);
    expect(jobs).toEqual([
      { serviceVi: 'Sửa điều hòa không mát / chảy nước', deviceVi: 'Máy lạnh', faultVi: 'Thiếu gas, xì gas', date: '2026-08-03' },
    ]);
  });

  it('falls back to the service name and the booking day, and leaves out what is unknown', () => {
    expect(pastJobsFromBookings([{ service: { name: '  Sửa tủ lạnh  ' }, createdAt: new Date('2026-09-20T03:00:00Z'), aiSummary: null }])).toEqual([
      { serviceVi: 'Sửa tủ lạnh', date: '2026-09-20' },
    ]);
  });

  it('skips rows with no service or no day, and keeps at most five', () => {
    const row = { serviceNameSnapshot: 'Sửa máy giặt', createdAt: '2026-09-01T00:00:00Z' };
    expect(pastJobsFromBookings([{ serviceNameSnapshot: ' ', createdAt: '2026-09-01T00:00:00Z' }, { serviceNameSnapshot: 'x', createdAt: 'not a date' }])).toEqual([]);
    expect(pastJobsFromBookings(Array.from({ length: 9 }, () => row))).toHaveLength(AI_PAST_JOBS_LIMITS.jobs);
  });

  it('bounds every field to what the AI Service accepts', () => {
    const [job] = pastJobsFromBookings([{ serviceNameSnapshot: 'S'.repeat(500), createdAt: '2026-09-01T00:00:00Z', aiSummary: { deviceName: 'D'.repeat(500), suspectedFaults: ['F'.repeat(500)] } }]);
    expect(job.serviceVi).toHaveLength(AI_PAST_JOBS_LIMITS.service);
    expect(job.deviceVi).toHaveLength(AI_PAST_JOBS_LIMITS.device);
    expect(job.faultVi).toHaveLength(AI_PAST_JOBS_LIMITS.fault);
  });
});
