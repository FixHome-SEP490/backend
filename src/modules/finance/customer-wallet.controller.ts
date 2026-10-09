import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants/error-codes';
import { PaymentMode, Role } from '../../shared/enums';
import { TopUpRequestDto } from '../wallet/dto/top-up.dto';
import { CustomerWalletService } from '../customer-wallet/customer-wallet.service';
import { FinanceService } from './finance.service';

type Req = { user: { id: string; role: string }; ip?: string; headers?: Record<string, string> };

/**
 * Customer wallet (PO 08/10/2026): see the balance and history, top up
 * through VNPay, pay an invoice from the balance. There is deliberately no
 * withdrawal: customers have no KYC.
 */
@ApiTags('Customer wallet')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.CUSTOMER)
@ApiBearerAuth()
export class CustomerWalletController {
  constructor(
    private readonly wallet: CustomerWalletService,
    private readonly finance: FinanceService,
  ) {}

  @Get('customer/wallet')
  @RequirePermission('profile:read_own')
  @ApiOperation({ summary: 'Customer: wallet balance and transactions, newest first' })
  summary(@Req() req: Req, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.wallet.summary(req.user.id, Number(page) || 1, Number(pageSize) || 20);
  }

  @Post('customer/wallet/top-up')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: start a VNPay top-up (10.000 - 50.000.000 ₫)' })
  async topUp(@Req() req: Req, @Body() dto: TopUpRequestDto) {
    // No simulated money (PO 07/10/2026): VNPay or nothing.
    if ((await this.finance.getPaymentMode()) !== PaymentMode.LIVE) {
      throw new BusinessException(ErrorCodes.PAYMENT_PROVIDER_UNAVAILABLE, 'Nạp tiền chưa mở vì cổng thanh toán chưa bật. Vui lòng liên hệ FixHome.');
    }
    const ua = req.headers?.['user-agent']?.toLowerCase() ?? '';
    const isMobile = req.headers?.['x-client-platform'] === 'mobile' || ua.includes('okhttp') || ua.includes('cfnetwork');
    const key = dto.idempotencyKey?.trim()
      || `CTOPUP_${req.user.id.substring(0, 8)}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const vnpay = await this.finance.createWalletTopUpVnpayUrl(req.user.id, dto.amount, req.ip || '127.0.0.1', key, isMobile ? 'mobile' : 'web', 'customer');
    return { paymentId: vnpay.paymentId, paymentUrl: vnpay.paymentUrl };
  }

  @Post('invoices/:id/pay-with-wallet')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: pay the whole invoice from the wallet balance' })
  payWithWallet(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string) {
    return this.finance.payInvoiceWithWallet(id, req.user);
  }
}
