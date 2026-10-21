import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { groupServiceIds, groupSiblings, mirrorGroupStatus, visitDevicesOf } from './visit-group-guard';
import { toTechnicianInvitationPreview } from './booking-privacy.dto';
import { BookingStatus } from '../../shared/enums';

// PO 21/10/2026: one technician with every skill takes the whole visit; matching
// runs on the lead booking and the other devices follow it.
const manager = (rows: { bookings?: object[]; items?: object[] } = {}) => ({
  find: vi.fn(async (entity: { name: string }) => entity.name === 'VisitGroupItem' ? rows.items ?? [] : rows.bookings ?? []),
  update: vi.fn(async () => undefined),
});

describe('visit group matching helpers', () => {
  it('asks a single booking for its own service only, without a query', async () => {
    const m = manager();
    expect(await groupServiceIds(m as never, { serviceId: 'svc-a', visitGroupId: null })).toEqual(['svc-a']);
    expect(await groupSiblings(m as never, { id: 'b-1', visitGroupId: null })).toEqual([]);
    await mirrorGroupStatus(m as never, { id: 'b-1', visitGroupId: null }, BookingStatus.MATCHING);
    expect(m.find).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });

  it('asks a visit for every distinct service of its devices', async () => {
    const m = manager({ bookings: [{ serviceId: 'svc-a' }, { serviceId: 'svc-b' }, { serviceId: 'svc-a' }] });
    expect(await groupServiceIds(m as never, { serviceId: 'svc-a', visitGroupId: 'g-1' })).toEqual(['svc-a', 'svc-b']);
  });

  it('moves the other devices to the lead booking status', async () => {
    const m = manager({ bookings: [{ id: 'b-2' }, { id: 'b-3' }] });
    await mirrorGroupStatus(m as never, { id: 'b-1', visitGroupId: 'g-1' }, BookingStatus.CLOSED);
    expect(m.update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: expect.anything() }), { status: BookingStatus.CLOSED });
  });

  it('lists the devices of a visit in the customer order, keyed by the invited booking', async () => {
    const m = manager({
      items: [{ groupId: 'g-1', sequence: 1, bookingId: 'b-1', deviceLabel: null }, { groupId: 'g-1', sequence: 2, bookingId: 'b-2', deviceLabel: 'Máy phòng khách' }],
      bookings: [{ id: 'b-2', serviceNameSnapshot: 'Tủ lạnh' }, { id: 'b-1', serviceNameSnapshot: 'Máy lạnh' }],
    });
    const devices = await visitDevicesOf(m as never, [{ id: 'b-1', visitGroupId: 'g-1' }, { id: 'solo', visitGroupId: null }]);
    expect(devices.get('b-1')?.map((d) => [d.sequence, d.deviceLabel, d.booking.serviceNameSnapshot])).toEqual([[1, null, 'Máy lạnh'], [2, 'Máy phòng khách', 'Tủ lạnh']]);
    expect(devices.has('solo')).toBe(false);
  });

  it('shows the technician every device before Accept, contact details masked', () => {
    const booking = (id: string, description: string) => ({ id, description, serviceNameSnapshot: id, quantity: 1, media: [] }) as never;
    const preview = toTechnicianInvitationPreview(
      { id: 'inv-1', bookingId: 'b-1', priorityOrder: 1, status: 'pending', invitedAt: new Date(), booking: booking('b-1', 'Máy kêu') } as never,
      { distanceKm: 2, visitDevices: [{ sequence: 1, deviceLabel: null, booking: booking('b-1', 'Máy kêu') }, { sequence: 2, deviceLabel: 'Bếp', booking: booking('b-2', 'Gọi 0901234567') }] },
    );
    expect(preview.visitDevices?.map((d) => d.booking.id)).toEqual(['b-1', 'b-2']);
    expect(preview.visitDevices?.[1].booking.description).toBe('Gọi [số điện thoại ẩn]');
    expect(preview.visitDevices?.[1].booking.distanceBand).toEqual(preview.booking.distanceBand);
    expect(toTechnicianInvitationPreview({ id: 'inv-2', bookingId: 'x', booking: booking('x', '') } as never)).not.toHaveProperty('visitDevices');
  });
});
