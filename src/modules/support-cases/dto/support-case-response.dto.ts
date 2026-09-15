import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BookingStatus,
  CashSettlementStatus,
  PaymentStatus,
  ServiceOrderStatus,
  SupportCaseStatus,
  SupportCaseType,
} from '../../../shared/enums';

export class SupportCaseBookingContextDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: BookingStatus })
  status: BookingStatus;

  @ApiProperty({ format: 'uuid' })
  customerId: string;

  @ApiProperty({ format: 'uuid' })
  serviceId: string;
}

export class SupportCaseServiceOrderContextDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  code: string;

  @ApiProperty({ enum: ServiceOrderStatus })
  status: ServiceOrderStatus;

  @ApiProperty({ enum: PaymentStatus })
  paymentStatus: PaymentStatus;

  @ApiProperty()
  laborTotal: number | null;

  @ApiProperty()
  partsTotal: number | null;

  @ApiProperty()
  grandTotal: number | null;
}

export class SupportCaseInvoiceContextDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  laborTotal: number | null;

  @ApiProperty()
  partsTotal: number | null;

  @ApiProperty()
  grandTotal: number | null;

  @ApiProperty({ enum: PaymentStatus })
  paymentStatus: PaymentStatus;

  @ApiProperty({ format: 'date-time' })
  issuedAt: Date;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  paidAt: Date | null;
}

export class SupportCaseCashSettlementContextDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: CashSettlementStatus })
  status: CashSettlementStatus;

  @ApiProperty()
  declaredAmount: number | null;

  @ApiPropertyOptional({ nullable: true })
  confirmedAmount: number | null;

  @ApiProperty({ format: 'date-time' })
  declaredAt: Date;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  confirmedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  technicianNotes: string | null;

  @ApiPropertyOptional({ nullable: true })
  receiptEvidenceUrl: string | null;
}

export class SupportCaseSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: SupportCaseType })
  caseType: SupportCaseType;

  @ApiProperty({ enum: SupportCaseStatus })
  status: SupportCaseStatus;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  bookingId: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  serviceOrderId: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  customerId: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  technicianId: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  createdByUserId: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  assignedManagerId: string | null;

  @ApiProperty({ maxLength: 2000 })
  reason: string;

  @ApiPropertyOptional({ maxLength: 5000, nullable: true })
  description: string | null;

  @ApiPropertyOptional({ maxLength: 128, nullable: true })
  resolutionCode: string | null;

  @ApiPropertyOptional({ maxLength: 2000, nullable: true })
  resolutionReason: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  evidenceRefs: string[] | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  resolvedAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

export class SupportCaseDetailDto extends SupportCaseSummaryDto {
  @ApiPropertyOptional({ type: SupportCaseBookingContextDto, nullable: true })
  booking: SupportCaseBookingContextDto | null;

  @ApiPropertyOptional({
    type: SupportCaseServiceOrderContextDto,
    nullable: true,
  })
  serviceOrder: SupportCaseServiceOrderContextDto | null;

  @ApiPropertyOptional({ type: SupportCaseInvoiceContextDto, nullable: true })
  invoice: SupportCaseInvoiceContextDto | null;

  @ApiPropertyOptional({
    type: SupportCaseCashSettlementContextDto,
    nullable: true,
  })
  cashSettlement: SupportCaseCashSettlementContextDto | null;
}

export { SupportCaseDetailDto as SupportCaseResponseDto };
