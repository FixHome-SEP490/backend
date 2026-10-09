import { describe, expect, it, vi } from 'vitest';
import { InvitationsService } from './invitations.service';
import { InvitationStatus, Role } from '../../shared/enums';

// "Tự nhận việc" (PO 10/10/2026): a pending invitation of a technician who switched it on is
// accepted for them through respond(), and left to them when it cannot be.
function setup(rows: Array<{ id: string; technicianId: string }>) {
  const query = vi.fn(async () => rows);
  const createNotification = vi.fn(async () => undefined);
  const warn = vi.fn();
  const service = Object.assign(Object.create(InvitationsService.prototype), {
    dataSource: { query },
    notificationsService: { createNotification },
    logger: { warn },
  }) as InvitationsService;
  const respond = vi.spyOn(service, 'respond');
  return { service, query, createNotification, warn, respond };
}

describe('auto-accept of invitations', () => {
  it('accepts as the technician, marks it automatic and tells them', async () => {
    const s = setup([{ id: 'inv-1', technicianId: 'tech-1' }]);
    s.respond.mockResolvedValue({ invitation: {} as never, serviceOrder: { id: 'order-1', code: 'FH-1' } as never });

    expect(await s.service.autoAcceptPending('booking-1')).toBe(true);

    expect(s.query).toHaveBeenCalledWith(expect.stringContaining('auto_accept_invitations'), ['booking-1', InvitationStatus.PENDING]);
    expect(s.respond).toHaveBeenCalledWith('inv-1', 'ACCEPT', { id: 'tech-1', role: Role.TECHNICIAN }, { auto: true });
    expect(s.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'tech-1', type: 'INVITATION_AUTO_ACCEPTED', referenceId: 'order-1', referenceType: 'SERVICE_ORDER',
    }));
  });

  it('leaves the invitation to the technician when accepting fails', async () => {
    const s = setup([{ id: 'inv-1', technicianId: 'tech-1' }]);
    s.respond.mockRejectedValue(new Error('Technician already has an order in this session'));

    expect(await s.service.autoAcceptPending('booking-1')).toBe(false);

    expect(s.createNotification).not.toHaveBeenCalled();
    expect(s.warn).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no waiting technician has it on', async () => {
    const s = setup([]);

    expect(await s.service.autoAcceptPending('booking-1')).toBe(false);

    expect(s.respond).not.toHaveBeenCalled();
  });
});
