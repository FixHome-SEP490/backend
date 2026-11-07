import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { Roles, RequirePermission } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard, PermissionGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { RiskLimit } from '../../common/rate-limit/risk-rate-limit';
import { FinanceService } from './finance.service';

type AuthorizedRequest = { user: { id: string; role: string } };

export class ConfirmManualBankTransferDto {
  @IsInt()
  @Min(1)
  amount: number;

  @IsString()
  @MinLength(6)
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{5,127}$/)
  bankReference: string;
}

/**
 * A customer CHOOSES manual bank transfer; no payment is verified until
 * an ADMIN inspects the actual receiving account and confirms its receipt.
 */
@ApiTags('Manual bank transfer')
@ApiBearerAuth()
@Controller('finance/manual-bank')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.CUSTOMER)
@RequirePermission('invoice:pay_own')
export class ManualBankController {
  constructor(private readonly finance: FinanceService) {}

  @Post(':invoiceId')
  @HttpCode(HttpStatus.OK)
  @RiskLimit('user-payment-init')
  @ApiOperation({ summary: 'Customer: open a PENDING manual bank-transfer request for own invoice' })
  async request(@Param('invoiceId', ParseUUIDPipe) invoiceId: string, @Req() req: AuthorizedRequest) {
    return { data: await this.finance.requestManualBankTransfer(invoiceId, req.user) };
  }
}

/** Admin can confirm only money already visible in the group's real bank account. */
@ApiTags('Admin / Manual bank transfer')
@ApiBearerAuth()
@Controller('admin/payments/manual-bank')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.ADMIN)
@RequirePermission('invoice:read_related')
export class AdminManualBankController {
  constructor(private readonly finance: FinanceService) {}

  @Post(':invoiceId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: verify real bank receipt + exact amount, then settle invoice and technician wallet once' })
  async confirm(
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() body: ConfirmManualBankTransferDto,
    @Req() req: AuthorizedRequest,
  ) {
    return { data: await this.finance.confirmManualBankTransfer(invoiceId, body, req.user) };
  }
}
