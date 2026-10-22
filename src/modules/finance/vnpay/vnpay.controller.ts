import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { PaymentPurpose } from '../../../shared/enums';
import { FinanceService } from '../finance.service';
import { pickWebOrigin } from './vnpay.util';

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

  /**
   * VNPay reads {"RspCode","Message"} at the top of the body. Returned through the
   * global envelope it came back as {success, data: {RspCode...}}, which VNPay
   * counts as an unconfirmed IPN and keeps retrying; so it is written as is.
   */
  @Get('ipn')
  async ipn(@Query() query: Record<string, string>, @Res() res: Response) {
    try {
      res.status(200).json(await this.financeService.handleVnpayIpn(query));
    } catch {
      // VNPay retries an IPN answered 99; nothing about the failure is exposed to it.
      res.status(200).json({ RspCode: '99', Message: 'Unknown error' });
    }
  }

  @Get('return')
  async returnUrl(@Query() query: Record<string, string>, @Res() res: Response) {
    const result = await this.financeService.handleVnpayReturn(query);
    // Back to the site that started the payment (local dev or the deployed
    // web share this backend), but only if it is one of the CORS origins.
    const frontendUrl = pickWebOrigin(
      query.web,
      this.config.get<string>('CORS_ORIGIN', ''),
      this.config.get<string>('FRONTEND_URL', 'http://localhost:5173'),
    );
    const isSuccess = result.ok ? 'success' : 'failed';

    if (result.purpose === PaymentPurpose.WALLET_TOP_UP) {
      const params = new URLSearchParams({ payment: isSuccess });
      if (result.amount) params.set('amount', String(result.amount));
      // A customer topped up their own wallet (PO 08/10/2026).
      if (result.payerRole === 'customer') {
        const isMobileApp = result.orderInfo?.includes('mobile') || query.app === 'mobile' || query.platform === 'mobile';
        return res.redirect(isMobileApp ? `fixhome://app/wallet?${params.toString()}` : `${frontendUrl}/app/wallet?${params.toString()}`);
      }

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
    if (result.visitGroupId) params.set('visitGroupId', result.visitGroupId);
    const isMobileApp = result.orderInfo?.includes('mobile') || query.app === 'mobile' || query.platform === 'mobile';
    res.redirect(isMobileApp ? `fixhome://app/order-payment?${params.toString()}` : `${frontendUrl}/vnpay-return?${params.toString()}`);
  }
}
