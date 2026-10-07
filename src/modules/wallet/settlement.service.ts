import { Injectable, Logger } from '@nestjs/common';
import { PlatformDueStatus } from '../../shared/enums';
import { PlatformDue } from '../finance/entities/platform-due.entity';
import { DataSource, EntityManager } from 'typeorm';
import {
  CashSettlementStatus,
  CommissionDueStatus,
  PaymentStatus,
  ServiceOrderStatus,
  WalletTransactionType,
} from '../../shared/enums';
import { CashSettlement } from '../service-orders/entities/cash-settlement.entity';
import { CommissionDue } from '../service-orders/entities/commission-due.entity';
import { Invoice } from '../service-orders/entities/invoice.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { WalletTransaction } from './entities';
import { WalletService } from './wallet.service';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly walletService: WalletService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Authoritative, idempotent settlement logic.
   * Can be safely called from multiple lifecycle events:
   * 1. Order status transition to COMPLETED
   * 2. Cash settlement confirmation
   * 3. Online payment verification
   */
  async trySettleOrder(
    orderId: string,
    existingManager?: EntityManager,
  ): Promise<{ settled: boolean; reason?: string }> {
    const runInManager = async (manager: EntityManager) => {
      const order = await manager.findOne(ServiceOrder, {
        where: { id: orderId },
      });
      if (!order) {
        return { settled: false, reason: 'ORDER_NOT_FOUND' };
      }
      if (order.status !== ServiceOrderStatus.COMPLETED) {
        this.logger.debug(
          `Order ${orderId} not COMPLETED yet (${order.status}); deferring settlement`,
        );
        return { settled: false, reason: 'ORDER_NOT_COMPLETED' };
      }

      const invoice = await manager.findOne(Invoice, {
        where: { serviceOrderId: orderId },
      });
      if (!invoice || invoice.paymentStatus !== PaymentStatus.PAID) {
        this.logger.debug(
          `Invoice for order ${orderId} not PAID yet; deferring settlement`,
        );
        return { settled: false, reason: 'PAYMENT_NOT_PAID' };
      }

      // Check if already settled (idempotent)
      const existingTx = await manager.findOne(WalletTransaction, {
        where: { referenceType: 'SERVICE_ORDER', referenceId: order.id },
      });
      if (existingTx) {
        this.logger.debug(
          `Order ${orderId} already settled via transaction ${existingTx.id}`,
        );
        return { settled: true, reason: 'ALREADY_SETTLED' };
      }

      // Determine technician
      const assignment = await manager.findOne(TechnicianAssignment, {
        where: { serviceOrderId: order.id },
        order: { assignedAt: 'DESC' },
      });

      const cashSettlement = await manager.findOne(CashSettlement, {
        where: { serviceOrderId: order.id },
      });

      const technicianId =
        assignment?.technicianId ?? cashSettlement?.declaredByTechnicianId;
      if (!technicianId) {
        this.logger.warn(
          `No technician found for order ${orderId}; cannot settle wallet`,
        );
        return { settled: false, reason: 'NO_TECHNICIAN_FOUND' };
      }

      const wallet = await this.walletService.getOrCreateWallet(
        technicianId,
        manager,
      );

      const isCash =
        cashSettlement?.status === CashSettlementStatus.CONFIRMED;

      if (isCash) {
        // CASH PAYMENT FLOW:
        // Technician collected 100% from customer directly.
        // Platform deducts Platform Fee (Commission + FixHome parts + shipping if any).
        const commissionAmount = Number(invoice.commissionAmount || 0);
        const fixHomeParts = Number(invoice.fixHomePartsTotal || 0);
        const shippingFee = Number(invoice.shippingFee || 0);
        const platformFee = commissionAmount + fixHomeParts + shippingFee;

        if (platformFee > 0) {
          await this.walletService.mutateBalance({
            walletId: wallet.id,
            type: WalletTransactionType.PLATFORM_FEE,
            amount: platformFee,
            referenceType: 'SERVICE_ORDER',
            referenceId: order.id,
            idempotencyKey: `PLATFORM_FEE:ORDER_${order.id}`,
            description: `Khấu trừ phí nền tảng cho đơn #${order.code}`,
            allowNegative: true, // System-generated charges may take wallet negative (Rule BR-WALLET-11)
            manager,
          });
          this.logger.log(
            `Debited platform fee ${platformFee} VND from technician ${technicianId} for cash order ${order.code}`,
          );
        }
      } else {
        // ONLINE PAYMENT FLOW:
        // FixHome holds 100% of customer funds.
        // Technician Net Earning = GrandTotal - Commission - FixHomeParts - ShippingFee
        const grandTotal = Number(invoice.grandTotal);
        const commissionAmount = Number(invoice.commissionAmount || 0);
        const fixHomeParts = Number(invoice.fixHomePartsTotal || 0);
        const shippingFee = Number(invoice.shippingFee || 0);
        const technicianNetEarning =
          grandTotal - commissionAmount - fixHomeParts - shippingFee;

        if (technicianNetEarning > 0) {
          await this.walletService.mutateBalance({
            walletId: wallet.id,
            type: WalletTransactionType.ONLINE_EARNING,
            amount: technicianNetEarning,
            referenceType: 'SERVICE_ORDER',
            referenceId: order.id,
            idempotencyKey: `ONLINE_EARNING:ORDER_${order.id}`,
            description: `Thu nhập ròng từ đơn sửa chữa #${order.code}`,
            allowNegative: false,
            manager,
          });
          this.logger.log(
            `Credited net earning ${technicianNetEarning} VND to technician ${technicianId} for online order ${order.code}`,
          );
        }
      }

      // Mark legacy CommissionDue as PAID so backward-compatibility queries don't see pending debt
      const dues = await manager.find(CommissionDue, {
        where: { serviceOrderId: order.id, status: CommissionDueStatus.PENDING },
      });
      for (const due of dues) {
        due.status = CommissionDueStatus.PAID;
        due.paidAt = new Date();
        due.paymentReference = `SETTLED_VIA_WALLET:${order.id}`;
        await manager.save(due);
      }
      // The platform fee was taken from the wallet above, so the cash
      // PlatformDue is settled too; nothing else ever closed it.
      await manager.update(
        PlatformDue,
        { serviceOrderId: order.id, status: PlatformDueStatus.PENDING },
        { status: PlatformDueStatus.SETTLED, settledAt: new Date() },
      );

      return { settled: true };
    };

    if (existingManager) {
      return runInManager(existingManager);
    }
    return this.dataSource.transaction(runInManager);
  }
}
