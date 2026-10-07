import { describe, expect, it, vi } from 'vitest';
import { InvitationsService } from './invitations.service';
import { BookingStatus, InvitationStatus } from '../../shared/enums';

describe('#33 matching sweep', () => {
  it('advances every matching booking whose invitation expired, and survives one that fails', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => [{ bookingId: 'booking-1' }, { bookingId: 'booking-2' }, { bookingId: 'booking-3' }]);
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
});
