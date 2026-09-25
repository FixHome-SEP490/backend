import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../shared/dto';
import {
  CashSettlementStatus,
  CommissionDueStatus,
  CostItemType,
  PaymentAttemptStatus,
  PaymentMode,
  PaymentPurpose,
  PaymentStatus,
  PlatformDueStatus,
} from '../../../shared/enums';
import { InvoiceItem } from '../../service-orders/entities/invoice-item.entity';
import { Invoice } from '../../service-orders/entities/invoice.entity';
import { CashSettlement } from '../../service-orders/entities/cash-settlement.entity';
import { CommissionDue } from '../../service-orders/entities/commission-due.entity';
import { Payment } from '../entities/payment.entity';
import { PlatformDue } from '../entities/platform-due.entity';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class InitiatePaymentDto {
  @ApiProperty({
    minLength: 16,
    maxLength: 128,
    example: 'checkout-20260915-4f7d1a2c',
    description: 'Client-generated retry key. Amount and provider are server-derived.',
  })
  @IsString()
  @IsNotEmpty()
  @Transform(trimString)
  @Length(16, 128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/)
  idempotencyKey: string;
}

export class CashSettlementDeclarationDto {
  @ApiProperty({ example: 125000, minimum: 0, description: 'Whole VND amount.' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999999999999)
  declaredAmount: number;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MaxLength(2000)
  technicianNotes?: string;

  @ApiPropertyOptional({ maxLength: 2048, description: 'Opaque evidence reference.' })
  @IsOptional()
  @IsString()
  @Transform(trimString)
  @MaxLength(2048)
  receiptEvidenceUrl?: string;
}

export class CashSettlementConfirmationDto {
  @ApiProperty({ description: 'Customer agrees only when the server invoice amount was received.' })
  @IsBoolean()
  agreed: boolean;

  @ApiPropertyOptional({ example: 125000, minimum: 0, description: 'Whole VND amount confirmed by the customer.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999999999999)
  confirmedAmount?: number;

  @ApiPropertyOptional({ minLength: 1, maxLength: 2000 })
  @ValidateIf((object) => object.agreed === false)
  @IsString()
  @IsNotEmpty()
  @Transform(trimString)
  @MaxLength(2000)
  disputeReason?: string;
}

export class PlatformDueQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PlatformDueStatus })
  @IsOptional()
  @IsEnum(PlatformDueStatus)
  status?: PlatformDueStatus;
}

export class InvoiceItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  sourceType: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  sourceItemId: string | null;

  @ApiProperty({ enum: CostItemType })
  type: CostItemType;

  @ApiProperty()
  description: string;

  @ApiProperty()
  quantity: number;

  @ApiProperty()
  unitPrice: number;

  @ApiProperty()
  lineTotal: number;

  @ApiProperty()
  warrantyDaysSnapshot: number;
}

export class InvoiceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  serviceOrderId: string;

  @ApiProperty()
  laborTotal: number;

  @ApiProperty()
  partsTotal: number;

  @ApiPropertyOptional()
  fixHomePartsTotal?: number;

  @ApiPropertyOptional()
  technicianPartsTotal?: number;

  @ApiPropertyOptional()
  technicianPartWarrantyFeeTotal?: number;
  @ApiPropertyOptional()
  shippingFee?: number;

  @ApiProperty()
  grandTotal: number;

  @ApiProperty()
  commissionBase: string;

  @ApiPropertyOptional()
  commissionRateSnapshot?: number;

  @ApiProperty()
  commissionAmount: number;

  @ApiProperty({ enum: PaymentStatus })
  paymentStatus: PaymentStatus;

  @ApiProperty({ format: 'date-time' })
  issuedAt: Date;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  paidAt: Date | null;

  @ApiProperty({ type: InvoiceItemResponseDto, isArray: true })
  items: InvoiceItemResponseDto[];
}

export class PaymentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  invoiceId: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  commissionDueId: string | null;

  @ApiProperty({ enum: PaymentPurpose })
  purpose: PaymentPurpose;

  @ApiProperty()
  amount: number;

  @ApiProperty({ example: 'VND' })
  currency: string;

  @ApiProperty({ enum: PaymentMode })
  mode: PaymentMode;

  @ApiProperty({ enum: PaymentAttemptStatus })
  status: PaymentAttemptStatus;

  @ApiProperty({ minLength: 16, maxLength: 128 })
  idempotencyKey: string;

  @ApiPropertyOptional({ nullable: true })
  failureCode: string | null;

  @ApiProperty({ format: 'date-time' })
  requestedAt: Date;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  verifiedAt: Date | null;
}

export class CashSettlementResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  serviceOrderId: string;

  @ApiProperty({ format: 'uuid' })
  declaredByTechnicianId: string;

  @ApiProperty()
  declaredAmount: number;

  @ApiProperty({ format: 'date-time' })
  declaredAt: Date;

  @ApiPropertyOptional({ nullable: true })
  technicianNotes: string | null;

  @ApiPropertyOptional({ nullable: true })
  receiptEvidenceUrl: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  confirmedByCustomerId: string | null;

  @ApiPropertyOptional({ nullable: true })
  confirmedAmount: number | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  confirmedAt: Date | null;

  @ApiProperty({ enum: CashSettlementStatus })
  status: CashSettlementStatus;

  @ApiPropertyOptional({ nullable: true })
  disputeReason: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  resolvedByManagerId: string | null;

  @ApiPropertyOptional({ nullable: true })
  managerResolutionReason: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  resolvedAt: Date | null;
}

export class CommissionDueResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  technicianId: string;

  @ApiProperty({ format: 'uuid' })
  serviceOrderId: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  cashSettlementId: string | null;

  @ApiProperty()
  laborTotalSnapshot: number;

  @ApiProperty()
  commissionRateSnapshot: number;

  @ApiProperty()
  dueAmount: number;

  @ApiProperty({ enum: CommissionDueStatus })
  status: CommissionDueStatus;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  paidAt: Date | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  dueDate: Date | null;
}

export class PlatformDueResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  invoiceId: string;

  @ApiProperty({ format: 'uuid' })
  serviceOrderId: string;

  @ApiProperty()
  laborTotalSnapshot: number;

  @ApiProperty()
  fixHomePartsTotalSnapshot: number;

  @ApiProperty()
  commissionRateSnapshot: number;

  @ApiProperty()
  commissionAmountSnapshot: number;

  @ApiProperty()
  dueAmount: number;

  @ApiProperty({ enum: PlatformDueStatus })
  status: PlatformDueStatus;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  settledAt: Date | null;
}

export const toInvoiceItemResponse = (item: InvoiceItem): InvoiceItemResponseDto => ({
  id: item.id,
  sourceType: item.sourceType,
  sourceItemId: item.sourceItemId ?? null,
  type: item.type,
  description: item.description,
  quantity: Number(item.quantity),
  unitPrice: Number(item.unitPrice),
  lineTotal: Number(item.lineTotal),
  warrantyDaysSnapshot: Number(item.warrantyDaysSnapshot),
});

export const toInvoiceResponse = (invoice: Invoice): InvoiceResponseDto => ({
  id: invoice.id,
  serviceOrderId: invoice.serviceOrderId,
  laborTotal: Number(invoice.laborTotal),
  partsTotal: Number(invoice.partsTotal),
  fixHomePartsTotal: Number(invoice.fixHomePartsTotal ?? 0),
  technicianPartsTotal: Number(invoice.technicianPartsTotal ?? 0),
  technicianPartWarrantyFeeTotal: Number(invoice.technicianPartWarrantyFeeTotal ?? 0),
  shippingFee: Number(invoice.shippingFee ?? 0),
  grandTotal: Number(invoice.grandTotal),
  commissionBase: invoice.commissionBase,
  commissionRateSnapshot: Number(invoice.commissionRateSnapshot ?? 0.1),
  commissionAmount: Number(invoice.commissionAmount),
  paymentStatus: invoice.paymentStatus,
  issuedAt: invoice.issuedAt,
  paidAt: invoice.paidAt ?? null,
  items: (invoice.items ?? []).map(toInvoiceItemResponse),
});

export const toPaymentResponse = (payment: Payment): PaymentResponseDto => ({
  id: payment.id,
  invoiceId: payment.invoiceId ?? null,
  commissionDueId: payment.commissionDueId ?? null,
  purpose: payment.purpose,
  amount: Number(payment.amount),
  currency: payment.currency,
  mode: payment.mode,
  status: payment.status,
  idempotencyKey: payment.idempotencyKey,
  failureCode: payment.failureCode ?? null,
  requestedAt: payment.requestedAt,
  verifiedAt: payment.verifiedAt ?? null,
});

export const toCashSettlementResponse = (
  settlement: CashSettlement,
): CashSettlementResponseDto => ({
  id: settlement.id,
  serviceOrderId: settlement.serviceOrderId,
  declaredByTechnicianId: settlement.declaredByTechnicianId,
  declaredAmount: Number(settlement.declaredAmount),
  declaredAt: settlement.declaredAt,
  technicianNotes: settlement.technicianNotes ?? null,
  receiptEvidenceUrl: settlement.receiptEvidenceUrl ?? null,
  confirmedByCustomerId: settlement.confirmedByCustomerId ?? null,
  confirmedAmount:
    settlement.confirmedAmount === undefined || settlement.confirmedAmount === null
      ? null
      : Number(settlement.confirmedAmount),
  confirmedAt: settlement.confirmedAt ?? null,
  status: settlement.status,
  disputeReason: settlement.disputeReason ?? null,
  resolvedByManagerId: settlement.resolvedByManagerId ?? null,
  managerResolutionReason: settlement.managerResolutionReason ?? null,
  resolvedAt: settlement.resolvedAt ?? null,
});

export const toCommissionDueResponse = (
  due: CommissionDue,
): CommissionDueResponseDto => ({
  id: due.id,
  technicianId: due.technicianId,
  serviceOrderId: due.serviceOrderId,
  cashSettlementId: due.cashSettlementId ?? null,
  laborTotalSnapshot: Number(due.laborTotalSnapshot),
  commissionRateSnapshot: Number(due.commissionRateSnapshot),
  dueAmount: Number(due.dueAmount),
  status: due.status,
  paidAt: due.paidAt ?? null,
  dueDate: due.dueDate ?? null,
});

export const toPlatformDueResponse = (
  due: PlatformDue,
): PlatformDueResponseDto => ({
  id: due.id,
  invoiceId: due.invoiceId,
  serviceOrderId: due.serviceOrderId,
  laborTotalSnapshot: Number(due.laborTotalSnapshot),
  fixHomePartsTotalSnapshot: Number(due.fixHomePartsTotalSnapshot),
  commissionRateSnapshot: Number(due.commissionRateSnapshot),
  commissionAmountSnapshot: Number(due.commissionAmountSnapshot),
  dueAmount: Number(due.dueAmount),
  status: due.status,
  settledAt: due.settledAt ?? null,
});
