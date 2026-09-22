import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BookingStatus, InvitationStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { AiDiagnosis } from './entities/ai-diagnosis.entity';
import { AiDiagnosisService } from './ai-diagnosis.service';
import { AiDiagnosisController } from './ai-diagnosis.controller';

function fixture() {
  const diagnosis = { id: 'synthetic-diagnosis', bookingId: 'synthetic-booking',
    rawResponse: { sensitive: 'PRIVATE_DIAGNOSIS_SENTINEL' } };
  const booking = { id: diagnosis.bookingId, customerId: 'customer-1', status: BookingStatus.MATCHED };
  const order = { id: 'order-1', bookingId: booking.id, status: ServiceOrderStatus.ACCEPTED };
  const invitations = [{ technicianId: 'tech-winner', status: InvitationStatus.ACCEPTED },
    { technicianId: 'tech-loser', status: InvitationStatus.CANCELLED }];
  let activeTechnician = 'tech-winner';
  let diagnosisExists = true;
  const manager = {
    findOneBy: vi.fn(async (entity: unknown, where: { id?: string; bookingId?: string; serviceOrderId?: string; technicianId?: string; isActive?: boolean; status?: InvitationStatus }) => {
      if (entity === AiDiagnosis) return diagnosisExists && where.id === diagnosis.id ? diagnosis : null;
      if (entity === ServiceOrder) return where.bookingId === booking.id ? order : null;
      if (entity === BookingInvitation) return invitations.find(i => i.technicianId === where.technicianId && i.status === where.status) ?? null;
      if (entity === TechnicianAssignment) return where.serviceOrderId === order.id &&
        where.technicianId === activeTechnician && where.isActive ? { id: 'active-assignment' } : null;
      return null;
    }),
    findOne: vi.fn(async (entity: unknown) => entity === Booking ? booking : entity === ServiceOrder ? order : null),
    find: vi.fn(async (entity: unknown) => entity === BookingInvitation ? invitations : []),
  };
  const transaction = vi.fn(async (fn: (m: typeof manager) => unknown) => fn(manager));
  const diagnosisRepo = { manager: { transaction }, findOneBy: vi.fn(async () => diagnosisExists ? diagnosis : null) };
  const service = new AiDiagnosisService(diagnosisRepo as never, {} as never, {} as never,
    { get: () => 'http://localhost:8000' } as never);
  const controller = new AiDiagnosisController(service);
  const actor = (id: string, role: Role) => ({ id, role });
  return { diagnosis, booking, order, manager, transaction, diagnosisRepo, service, controller, actor,
    setActive: (id: string) => { activeTechnician = id; },
    setMissing: () => { diagnosisExists = false; },
  };
}

describe('PRIVACY-B: stored diagnosis ownership', () => {
  it('forwards authenticated actor from controller to service', async () => {
    const f = fixture();
    await f.controller.getById(f.diagnosis.id, { user: f.actor('customer-1', Role.CUSTOMER) });
    expect(f.transaction).toHaveBeenCalledTimes(1);
  });
  it('customer can read only the diagnosis of their own Booking', async () => {
    const f = fixture();
    await expect(f.service.findById(f.diagnosis.id, f.actor('customer-1', Role.CUSTOMER))).resolves.toEqual(f.diagnosis);
    await expect(f.service.findById(f.diagnosis.id, f.actor('customer-2', Role.CUSTOMER))).rejects.toThrow();
  });
  it('denies unrelated, pending, cancelled, and inactive-assignment technicians even with diagnosis UUID', async () => {
    const f = fixture();
    for (const id of ['tech-unrelated', 'tech-pending', 'tech-loser']) {
      await expect(f.service.findById(f.diagnosis.id, f.actor(id, Role.TECHNICIAN))).rejects.toThrow();
    }
    f.setActive('tech-replacement');
    await expect(f.service.findById(f.diagnosis.id, f.actor('tech-winner', Role.TECHNICIAN))).rejects.toThrow();
  });
  it('allows only current accepted and actively assigned winning technician', async () => {
    const f = fixture();
    await expect(f.service.findById(f.diagnosis.id, f.actor('tech-winner', Role.TECHNICIAN))).resolves.toEqual(f.diagnosis);
    f.booking.status = BookingStatus.MATCHING;
    await expect(f.service.findById(f.diagnosis.id, f.actor('tech-winner', Role.TECHNICIAN))).rejects.toThrow();
  });
  it('staff access is role-gated and missing record uses the same generic denial', async () => {
    const f = fixture();
    await expect(f.service.findById(f.diagnosis.id, f.actor('admin-1', Role.ADMIN))).resolves.toEqual(f.diagnosis);
    await expect(f.service.findById(f.diagnosis.id, f.actor('manager-1', Role.SERVICE_MANAGER))).resolves.toEqual(f.diagnosis);
    await expect(f.service.findById(f.diagnosis.id, f.actor('stranger', Role.CUSTOMER))).rejects.toThrow('Diagnosis not found');
    f.setMissing();
    await expect(f.service.findById(f.diagnosis.id, f.actor('customer-1', Role.CUSTOMER))).rejects.toThrow('Diagnosis not found');
  });
  it('rejects diagnosis read after ServiceOrder cancellation even with historical accepted invitation', async () => {
    const f = fixture();
    f.order.status = ServiceOrderStatus.CANCELLED;
    await expect(f.service.findById(f.diagnosis.id, f.actor('tech-winner', Role.TECHNICIAN))).rejects.toThrow('Diagnosis not found');
  });
  it('locks Booking and ServiceOrder during authorized technician read', async () => {
    const f = fixture();
    await f.service.findById(f.diagnosis.id, f.actor('tech-winner', Role.TECHNICIAN));
    expect(f.manager.findOne).toHaveBeenCalledWith(Booking, {
      where: { id: f.booking.id }, lock: { mode: 'pessimistic_write' },
    });
    expect(f.manager.findOne).toHaveBeenCalledWith(ServiceOrder, {
      where: { bookingId: f.booking.id }, lock: { mode: 'pessimistic_write' },
    });
  });
});