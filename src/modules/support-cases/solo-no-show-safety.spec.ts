import { describe, expect, it, vi } from 'vitest';
import { TechnicianReportService } from './technician-report.service';
import { Role } from '../../shared/enums';
import { TechnicianReportReasonClass, TechnicianReportReasonCode } from './dto/technician-report.dto';

// B2 parity is BLOCKED pending an approved solo contact/readiness transport contract.
// Keep existing stop routes fail-closed; client prose/timestamps cannot release or blame.
describe('solo no-show safety until evidence-gated parity is implemented', () => {
  it.each([TechnicianReportReasonCode.CUSTOMER_ABSENT, TechnicianReportReasonCode.CUSTOMER_UNREACHABLE])(
    'does not release or penalize from a solo %s command without server evidence', async reasonCode => {
      const transaction = vi.fn();
      const penalize = vi.fn();
      const service = new TechnicianReportService({ transaction } as never, {} as never, { penalize } as never);
      const input = { commandId: '11111111-1111-4111-8111-111111111111', reasonCode,
        reasonClass: TechnicianReportReasonClass.NON_TECHNICIAN, reason: 'Synthetic no-show report',
        callTimes: ['2000-01-01', '2000-01-02'], notificationSent: true };
      await expect(service.cannotContinue('order', input, { id: 'tech', role: Role.TECHNICIAN })).rejects.toThrow();
      expect(transaction).not.toHaveBeenCalled();
      expect(penalize).not.toHaveBeenCalled();
    });

  it.each([TechnicianReportReasonCode.CUSTOMER_ABSENT, TechnicianReportReasonCode.CUSTOMER_UNREACHABLE])(
    'cannot bypass the solo %s stop gate through an ambient transaction', async reasonCode => {
      const manager = { update: vi.fn(), save: vi.fn() };
      const service = new TechnicianReportService({} as never, {} as never, {} as never);
      await expect(service.stopWithinTransaction(manager as never, 'order', {
        commandId: '11111111-1111-4111-8111-111111111111', reasonCode,
        reasonClass: TechnicianReportReasonClass.NON_TECHNICIAN, reason: 'Synthetic no-show report',
      }, { id: 'tech', role: Role.TECHNICIAN })).rejects.toThrow();
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });
});
