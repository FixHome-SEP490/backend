import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PaymentPurpose } from '../../../shared/enums';
import { FinanceService } from '../finance.service';

/**
 * Public endpoints called directly by VNPay (no JWT — the browser or VNPay's
 * server has no session here). Security relies entirely on HMAC signature
 * verification inside FinanceService.
 */
@ApiExcludeController()
@Controller('finance/vnpay')
export class VnpayController {
  constructor(
    private readonly financeService: FinanceService,
    private readonly config: ConfigService,
  ) {}

  @Get('ipn')
  async ipn(@Query() query: Record<string, string>) {
    return this.financeService.handleVnpayIpn(query);
  }

  @Get('return')
  async returnUrl(@Query() query: Record<string, string>, @Res() res: Response) {
    const result = await this.financeService.handleVnpayReturn(query);
    const frontendUrl = this.config.get<string>('FRONTEND_URL', 'http://localhost:5173');
    const isSuccess = result.ok ? 'success' : 'failed';

    if (result.purpose === PaymentPurpose.WALLET_TOP_UP) {
      const params = new URLSearchParams({ payment: isSuccess });
      if (result.amount) params.set('amount', String(result.amount));

      const isMobile =
        result.orderInfo?.includes('mobile') ||
        query.app === 'mobile' ||
        query.platform === 'mobile';
      if (isMobile) {
        return res.redirect(`fixhome://tech/wallet?${params.toString()}`);
      }
      return res.redirect(`${frontendUrl}/tech/wallet?${params.toString()}`);
    }

    const params = new URLSearchParams({ payment: isSuccess });
    if (result.invoiceId) params.set('invoiceId', result.invoiceId);
    if (result.serviceOrderId) params.set('orderId', result.serviceOrderId);
    res.redirect(`${frontendUrl}/vnpay-return?${params.toString()}`);
  }
}
