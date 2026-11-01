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

  @ApiPropertyOptional({ nullable: true })
  disputeReason: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  disputedByCustomerId: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  disputedAt: Date | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  resolvedByManagerId: string | null;

  @ApiPropertyOptional({ nullable: true })
  managerResolutionReason: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  resolvedAt: Date | null;
}

export class SupportCaseSummaryDto {
  @ApiProperty({ enum: ['NOT_RECORDED', 'DECISION_RECORDED', 'DOMAIN_ACTION_EXECUTED', 'EXECUTION_NOT_VERIFIED', 'ESCALATED_ADMIN'],
    description: 'A recorded decision does not execute a price, warranty, refund or sanction command; list entries conservatively leave specialized execution unverified' })
  resolutionExecutionKind: 'NOT_RECORDED' | 'DECISION_RECORDED' | 'DOMAIN_ACTION_EXECUTED' | 'EXECUTION_NOT_VERIFIED' | 'ESCALATED_ADMIN';

  @ApiProperty()
  needsManualAction: boolean;

  @ApiPropertyOptional({ enum: ['service_manager', 'admin'], nullable: true, description: 'Admin review is read-only and grants no resolution/finance rights' })
  nextActor: 'service_manager' | 'admin' | null;

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

  @ApiProperty()
  isUrgent: boolean;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  respondBy: Date | null;

  @ApiProperty()
  holdCompletion: boolean;

  @ApiPropertyOptional({ enum: ['stop_or_replace'], nullable: true })
  requestIntent: 'stop_or_replace' | null;

  @ApiProperty()
  workflowVersion: number;

  @ApiPropertyOptional({ nullable: true })
  reasonClass: string | null;

  @ApiPropertyOptional({ nullable: true })
  reasonCode: string | null;

  @ApiPropertyOptional({ nullable: true })
  responsibility: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  responsibilityActorId: string | null;

  @ApiPropertyOptional({ nullable: true })
  responsibilityReason: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  responsibilityEvidenceRefs: string[] | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  responsibilityDecidedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  liableParty: string | null;

  @ApiPropertyOptional({ nullable: true })
  amount: number | null;

  @ApiPropertyOptional({ nullable: true, description: "Manager-approved original gross basis for funded voucher refund" })
  voucherGrossRefundVnd: number | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

/** What a technician reported about a late or released next order (PO 31/10/2026); read-only for the manager. Fields are null when a newer report on the same order replaced them. */
export class SupportCaseTechnicianDelayDto {
  @ApiProperty({ nullable: true }) reasonCode: string | null;
  @ApiProperty({ nullable: true }) delayMinutes: number | null;
  @ApiProperty({ nullable: true }) noticedAt: Date | null;
  @ApiProperty({ nullable: true, description: 'wait | switch | cancel once the customer answered' }) decision: string | null;
  @ApiProperty({ format: 'uuid', nullable: true, description: 'The job the technician is still on; its ADDITIONAL photos are the evidence.' }) currentOrderId: string | null;
  @ApiProperty({ nullable: true }) currentOrderCode: string | null;
}

export class SupportCaseDetailDto extends SupportCaseSummaryDto {
  @ApiPropertyOptional({ type: SupportCaseBookingContextDto, nullable: true })
  booking: SupportCaseBookingContextDto | null;

  @ApiPropertyOptional({
    type: SupportCaseServiceOrderContextDto,
    nullable: true,
  })
  serviceOrder: SupportCaseServiceOrderContextDto | null;

  @ApiPropertyOptional({ type: SupportCaseTechnicianDelayDto, nullable: true })
  technicianDelay: SupportCaseTechnicianDelayDto | null;

  @ApiPropertyOptional({ type: SupportCaseInvoiceContextDto, nullable: true })
  invoice: SupportCaseInvoiceContextDto | null;

  @ApiPropertyOptional({
    type: SupportCaseCashSettlementContextDto,
    nullable: true,
  })
  cashSettlement: SupportCaseCashSettlementContextDto | null;
}

export { SupportCaseDetailDto as SupportCaseResponseDto };
