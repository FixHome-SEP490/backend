import { describe, expect, it, vi } from 'vitest';
import { InvitationsService } from './invitations.service';
import { BookingStatus, InvitationStatus } from '../../shared/enums';

describe('#33 matching sweep', () => {
  it('advances every matching booking whose invitation expired, and survives one that fails', async () => {
    // First the bookings to advance; then none waiting for "tự nhận việc".
    const query = vi.fn(async (_sql: string, _params: unknown[]): Promise<Array<{ bookingId: string }>> => [])
      .mockResolvedValueOnce([{ bookingId: 'booking-1' }, { bookingId: 'booking-2' }, { bookingId: 'booking-3' }]);
    const warn = vi.fn();
    const service = Object.assign(Object.create(InvitationsService.prototype), {
      dataSource: { query },
      logger: { warn },
    }) as InvitationsService;
    const refresh = vi.spyOn(service, 'refreshMatching').mockImplementation(async (id: string) => {
      if (id === 'booking-2') throw new Error('locked');
    });

    await service.sweepMatching();

    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['booking-1', 'booking-2', 'booking-3']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([BookingStatus.MATCHING, InvitationStatus.PENDING, InvitationStatus.STANDBY]);
  });

  it('hands every booking waiting on a "tự nhận việc" technician to auto-accept (PO 10/10/2026)', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]): Promise<Array<{ bookingId: string }>> => [])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ bookingId: 'booking-9' }]);
    const service = Object.assign(Object.create(InvitationsService.prototype), {
      dataSource: { query },
      logger: { warn: vi.fn() },
    }) as InvitationsService;
    const auto = vi.spyOn(service, 'autoAcceptPending').mockResolvedValue(true);

    await service.sweepMatching();

    expect(auto.mock.calls.map(([id]) => id)).toEqual(['booking-9']);
    expect(String(query.mock.calls[1][0])).toContain('auto_accept_invitations');
    expect(query.mock.calls[1][1]).toEqual([BookingStatus.MATCHING, InvitationStatus.PENDING]);
  });
});
