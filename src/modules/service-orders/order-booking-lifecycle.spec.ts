import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { closeBookingForCancelledOrder, overdueDeadline } from './close-cancelled-booking';
import { holderPartRequests, releaseOutgoingTechnicianPartRequests } from '../part-requests/part-request-lifecycle';
import { technicianEligibility } from '../bookings/technician-eligibility';
import type { Booking } from '../bookings/entities/booking.entity';
import type { PartRequest } from '../part-requests/entities/part-request.entity';
import { AccountStatus, BookingStatus, InvitationStatus, PartRequestStatus, Role, VerificationStatus } from '../../shared/enums';

const at = (iso: string) => new Date(iso);

describe('When an accepted order counts as a no-show', () => {
  it('counts from the end of the window, not its start', () => {
    const deadline = overdueDeadline(at('2030-01-01T05:00:00Z'), at('2030-01-01T03:00:00Z'), at('2030-01-01T01:00:00Z'), 60);
    expect(deadline).toEqual(at('2030-01-01T06:00:00Z'));
  });

  it('never before the technician accepted plus the grace period', () => {
    // a late invitee accepted after the window had already closed
    const deadline = overdueDeadline(at('2030-01-01T05:00:00Z'), null, at('2030-01-01T07:30:00Z'), 60);
    expect(deadline).toEqual(at('2030-01-01T08:30:00Z'));
  });

  it('falls back to the scheduled time when the booking has no window, and to none at all', () => {
    expect(overdueDeadline(null, at('2030-01-01T03:00:00Z'), at('2030-01-01T01:00:00Z'), 30)).toEqual(at('2030-01-01T03:30:00Z'));
    expect(overdueDeadline(null, null, at('2030-01-01T01:00:00Z'), 30)).toBeNull();
  });
});

describe('Cancelling an order closes its booking', () => {
  it('cancels the booking and every invitation still open', async () => {
    const update = vi.fn(async () => ({ affected: 1 }));
    await closeBookingForCancelledOrder({ update } as unknown as EntityManager, 'booking-1');
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ name: 'Booking' }), 'booking-1', { status: BookingStatus.CANCELLED });
    const [entity, where, values] = update.mock.calls[1] as unknown as [{ name: string }, { bookingId: string; status: { value: string[] } }, { status: string }];
    expect(entity.name).toBe('BookingInvitation');
    expect(where.bookingId).toBe('booking-1');
    expect(where.status.value).toEqual([InvitationStatus.PENDING, InvitationStatus.STANDBY]);
    expect(values.status).toBe(InvitationStatus.CANCELLED);
  });
});

describe('Part requests when the technician changes', () => {
  it('releases only what the outgoing technician has not picked up', async () => {
    const update = vi.fn(async () => ({ affected: 1 }));
    await releaseOutgoingTechnicianPartRequests({ update } as unknown as EntityManager, 'order-1', 'tech-old');
    const [, where, values] = update.mock.calls[0] as unknown as [unknown, { technicianId: string; status: { value: string[] } }, { status: string }];
    expect(where.technicianId).toBe('tech-old');
    expect(where.status.value).toEqual([PartRequestStatus.REQUESTED, PartRequestStatus.READY, PartRequestStatus.DELIVERING]);
    expect(values.status).toBe(PartRequestStatus.CANCELLED);
  });

  it('gates completion on the current technician\'s requests only', async () => {
    const requests = [
      { id: 'mine', technicianId: 'tech-new' },
      { id: 'left-behind', technicianId: 'tech-old' },
    ] as PartRequest[];
    const manager = { findOneBy: vi.fn(async () => ({ technicianId: 'tech-new' })) } as unknown as EntityManager;
    expect((await holderPartRequests(manager, 'order-1', requests)).map((r) => r.id)).toEqual(['mine']);
  });
});

describe('Rescheduling keeps a technician who is free at the new time', () => {
  function technicianWith(state: { paused?: boolean; unpaidDue?: boolean; lowWallet?: boolean; busy?: boolean }) {
    const booking = { id: 'booking-1', serviceId: 'service-1', latitudeSnapshot: 10.77, longitudeSnapshot: 106.7,
      preferredStartAt: at('2030-10-15T03:00:00Z'), preferredEndAt: at('2030-10-15T04:00:00Z') } as Booking;
    const manager = {
      findOneBy: vi.fn(async (entity: { name?: string }) => {
        if (entity.name === 'User') return { id: 'tech-1', role: Role.TECHNICIAN, status: AccountStatus.ACTIVE };
        if (entity.name === 'TechnicianProfile') return { id: 'profile-1', verificationStatus: VerificationStatus.VERIFIED, isAvailable: !state.paused, serviceRadiusKm: 10 };
        if (entity.name === 'TechnicianSkill') return { id: 'skill-1' };
        if (entity.name === 'Wallet') return { balance: state.lowWallet ? 0 : 1_000_000 };
        if (entity.name === 'Address') return { lat: 10.77, lng: 106.7 };
        return null;
      }),
      count: vi.fn(async () => (state.unpaidDue ? 1 : 0)),
      find: vi.fn(async (entity: { name?: string }) => entity.name === 'TechnicianSchedule' ? [{ dayOfWeek: 2, startTime: '08:00', endTime: '18:00' }] : []),
      createQueryBuilder: vi.fn((entity: unknown) => {
        const qb = {
          select: vi.fn(() => qb), addSelect: vi.fn(() => qb), innerJoin: vi.fn(() => qb), where: vi.fn(() => qb), andWhere: vi.fn(() => qb),
          getMany: vi.fn(async () => []),
          getRawMany: vi.fn(async () => (state.busy && typeof entity === 'string' ? [{ busyStart: booking.preferredStartAt, busyEnd: booking.preferredEndAt }] : [])),
        };
        return qb;
      }),
    } as unknown as EntityManager;
    return { manager, booking };
  }
  const keeping = { keepingExistingOrder: true };

  it('keeps a paused technician with a low wallet and an unpaid due', async () => {
    const { manager, booking } = technicianWith({ paused: true, unpaidDue: true, lowWallet: true });
    expect((await technicianEligibility(manager, 'tech-1', booking, 'order-1')).eligible).toBe(false);
    expect((await technicianEligibility(manager, 'tech-1', booking, 'order-1', keeping)).eligible).toBe(true);
  });

  it('still lets go of a technician who is busy at the new time', async () => {
    const { manager, booking } = technicianWith({ busy: true });
    const verdict = await technicianEligibility(manager, 'tech-1', booking, 'order-1', keeping);
    expect(verdict).toEqual({ eligible: false, reason: 'Assignment schedule conflict' });
  });
});
