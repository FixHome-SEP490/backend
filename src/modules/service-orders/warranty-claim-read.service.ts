import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CostItemType } from '../../shared/enums';
import { Booking } from '../bookings/entities/booking.entity';
import { PartRequest } from '../part-requests/entities/part-request.entity';
import { User } from '../users/entities/user.entity';
import { StaffWarrantyClaimDto } from './dto/warranty-claim.dto';
import { Invoice } from './entities/invoice.entity';
import { InvoiceItem } from './entities/invoice-item.entity';
import { ServiceOrder } from './entities/service-order.entity';
import { WarrantyClaim } from './entities/warranty-claim.entity';
import { WarrantyCoverage } from './entities/warranty-coverage.entity';
import { WarrantyVisit } from './entities/warranty-visit.entity';
import { toClaimView, toVisitView } from './warranty-claim.mapper';

/** Builds the technician/manager view of claims (order, customer, coverage and latest visit). */
@Injectable()
export class WarrantyClaimReadService {
  constructor(
    @InjectRepository(ServiceOrder) private readonly orderRepo: Repository<ServiceOrder>,
    @InjectRepository(Booking) private readonly bookingRepo: Repository<Booking>,
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    @InjectRepository(WarrantyCoverage) private readonly coverageRepo: Repository<WarrantyCoverage>,
    @InjectRepository(WarrantyVisit) private readonly visitRepo: Repository<WarrantyVisit>,
    @InjectRepository(InvoiceItem) private readonly invoiceItemRepo: Repository<InvoiceItem>,
  ) {}

  async toStaffViews(claims: WarrantyClaim[]): Promise<StaffWarrantyClaimDto[]> {
    if (!claims.length) return [];
    const unique = <T>(values: T[]) => [...new Set(values)];

    const orders = await this.orderRepo.find({
      where: { id: In(unique(claims.map((c) => c.serviceOrderId))) },
    });
    const bookings = await this.bookingRepo.find({
      where: { id: In(unique(orders.map((o) => o.bookingId))) },
    });
    const customers = await this.userRepo.find({
      where: { id: In(unique(bookings.map((b) => b.customerId))) },
      select: ['id', 'fullName', 'phoneNumber'],
    });
    const coverages = await this.coverageRepo.find({
      where: { id: In(unique(claims.map((c) => c.warrantyCoverageId))) },
    });
    const itemIds = unique(coverages.map((c) => c.invoiceItemId).filter((id): id is string => !!id));
    const items = itemIds.length ? await this.invoiceItemRepo.find({ where: { id: In(itemIds) } }) : [];
    const itemName = new Map(items.map((item) => [item.id, item.description]));
    const visits = await this.visitRepo.find({
      where: { warrantyClaimId: In(claims.map((c) => c.id)) },
      order: { createdAt: 'DESC' },
    });

    // Part lines of each order's invoice (the technician names the faulty ones) and the free warranty part, if any.
    const manager = this.orderRepo.manager;
    const invoices = await manager.find(Invoice, { where: { serviceOrderId: In(orders.map((o) => o.id)) } });
    const partLines = invoices.length
      ? await this.invoiceItemRepo.find({ where: { invoiceId: In(invoices.map((i) => i.id)), type: CostItemType.PARTS_EQUIPMENT } })
      : [];
    const orderOfInvoice = new Map(invoices.map((i) => [i.id, i.serviceOrderId]));
    const requests = await manager.find(PartRequest, { where: { warrantyClaimId: In(claims.map((c) => c.id)) } });
    const requestByClaim = new Map(requests.map((r) => [r.warrantyClaimId as string, r]));

    const orderById = new Map(orders.map((o) => [o.id, o]));
    const bookingById = new Map(bookings.map((b) => [b.id, b]));
    const customerById = new Map(customers.map((u) => [u.id, u]));
    const coverageById = new Map(coverages.map((c) => [c.id, c]));
    const latestVisit = new Map<string, WarrantyVisit>();
    for (const visit of visits) {
      if (!latestVisit.has(visit.warrantyClaimId)) latestVisit.set(visit.warrantyClaimId, visit);
    }

    return claims.map((claim) => {
      const order = orderById.get(claim.serviceOrderId);
      const booking = order ? bookingById.get(order.bookingId) : undefined;
      const customer = booking ? customerById.get(booking.customerId) : undefined;
      const coverage = coverageById.get(claim.warrantyCoverageId);
      const visit = latestVisit.get(claim.id);
      return {
        ...toClaimView(claim),
        order: {
          id: claim.serviceOrderId,
          code: order?.code ?? '',
          bookingId: order?.bookingId ?? '',
          serviceName: booking?.serviceNameSnapshot ?? '',
          addressSummary: booking?.addressTextSnapshot ?? '',
          customerName: customer?.fullName ?? '',
          customerPhone: customer?.phoneNumber ?? '',
          partLines: partLines
            .filter((line) => orderOfInvoice.get(line.invoiceId) === claim.serviceOrderId)
            .map((line) => ({ id: line.id, name: line.description, quantity: line.quantity, partSource: line.partSource ?? null })),
        },
        coverage: coverage
          ? {
              id: coverage.id,
              // What the customer is covered for: the invoice line, else the note, else a generic name.
              itemDescription: itemName.get(coverage.invoiceItemId ?? '') || coverage.note || 'Bảo hành dịch vụ',
              expiresAt: coverage.expiresAt,
            }
          : null,
        visit: visit ? toVisitView(visit) : null,
        declineReview: claim.declineReview ?? null,
        declineReasonCode: claim.declineReasonCode ?? null,
        outcomeCode: claim.outcomeCode ?? null,
        refundAmount: claim.refundAmount ?? null,
        noShowFlaggedAt: claim.noShowFlaggedAt ?? null,
        partRequest: requestByClaim.has(claim.id)
          ? (() => {
              const r = requestByClaim.get(claim.id) as PartRequest;
              return {
                id: r.id, status: r.status, faultyReturnDueAt: r.faultyReturnDueAt ?? null, faultyReturnedAt: r.faultyReturnedAt ?? null,
                faultyReturnChargedAt: r.faultyReturnChargedAt ?? null, faultyInspectionResult: r.faultyInspectionResult ?? null,
                chargeTechnician: r.chargeTechnician,
              };
            })()
          : null,
      };
    });
  }
}
