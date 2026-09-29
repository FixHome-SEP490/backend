import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { StaffWarrantyClaimDto } from './dto/warranty-claim.dto';
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
    const visits = await this.visitRepo.find({
      where: { warrantyClaimId: In(claims.map((c) => c.id)) },
      order: { createdAt: 'DESC' },
    });

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
          serviceName: booking?.serviceNameSnapshot ?? '',
          addressSummary: booking?.addressTextSnapshot ?? '',
          customerName: customer?.fullName ?? '',
          customerPhone: customer?.phoneNumber ?? '',
        },
        coverage: coverage
          ? {
              id: coverage.id,
              itemDescription: coverage.note || 'Bảo hành dịch vụ',
              expiresAt: coverage.expiresAt,
            }
          : null,
        visit: visit ? toVisitView(visit) : null,
      };
    });
  }
}
