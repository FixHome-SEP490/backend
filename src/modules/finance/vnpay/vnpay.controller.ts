import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
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
    const status = result.ok ? 'success' : 'failed';
    const target = result.invoiceId
      ? `${frontendUrl}/vnpay-return?payment=${status}&invoiceId=${result.invoiceId}`
      : `${frontendUrl}/vnpay-return?payment=${status}`;
    res.redirect(target);
  }
}
