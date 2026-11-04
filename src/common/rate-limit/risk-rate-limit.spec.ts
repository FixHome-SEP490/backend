import { GUARDS_METADATA } from '@nestjs/common/constants';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { describe, expect, it, vi } from 'vitest';
import { AuthController } from '../../modules/auth/auth.controller';
import { AiDiagnosisController } from '../../modules/ai-diagnosis/ai-diagnosis.controller';
import { BookingsController } from '../../modules/bookings/bookings.controller';
import { VisitGroupsController } from '../../modules/visit-groups/visit-groups.controller';
import { CustomerWalletController } from '../../modules/finance/customer-wallet.controller';
import { FundedFinanceController } from '../../modules/finance/finance.controller';
import { VnpayController } from '../../modules/finance/vnpay/vnpay.controller';
import { ServiceOrdersController } from '../../modules/service-orders/service-orders.controller';
import { MediaController } from '../../modules/media/media.controller';
import { ConversationsController, MessagesController } from '../../modules/messaging/messaging.controller';
import { MessagingGateway } from '../../modules/messaging/messaging.gateway';

const RISK_LIMIT_METADATA = 'fixhome:risk-limit-bucket';

function bucketOf(handler: Function): string | undefined {
  return Reflect.getMetadata(RISK_LIMIT_METADATA, handler) as string | undefined;
}

function guardsOf(handler: Function): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [];
}

function guardName(guard: unknown): string | undefined {
  return typeof guard === 'function'
    ? guard.name
    : (guard as { constructor?: { name?: string } })?.constructor?.name;
}

function riskGuardOf(handler: Function): { canActivate: (context: ExecutionContext) => boolean } | undefined {
  return guardsOf(handler).find((guard) => guardName(guard) === 'RiskRateLimitGuard') as
    | { canActivate: (context: ExecutionContext) => boolean }
    | undefined;
}

function httpContext(handler: Function, request: Record<string, unknown>, response = { setHeader: vi.fn() }): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

describe('P0-1A risk rate limits', () => {
  it('uses one create bucket for solo and grouped visits and a separate consultation bucket', () => {
    expect(bucketOf(BookingsController.prototype.create)).toBe('booking-create');
    expect(bucketOf(VisitGroupsController.prototype.create)).toBe('booking-create');
    expect(bucketOf(VisitGroupsController.prototype.consultation)).toBe('booking-consultation');
    expect(bucketOf(BookingsController.prototype.rebook)).toBeUndefined();
    expect(bucketOf(BookingsController.prototype.confirmInterruptionRebook)).toBeUndefined();

    const bookingGuards = guardsOf(BookingsController.prototype.create).map(guardName);
    expect(bookingGuards).toEqual(['JwtAuthGuard', 'PermissionGuard', 'RiskRateLimitGuard']);
  });

  it('limits payment-init routes while leaving signed VNPay IPN, auth, and AI guards independent', () => {
    const paymentRoutes = [
      CustomerWalletController.prototype.topUp,
      CustomerWalletController.prototype.payWithWallet,
      ServiceOrdersController.prototype.createInvoiceVnpayUrl,
      VisitGroupsController.prototype.payWithVnpay,
      FundedFinanceController.prototype.soloVnpay,
      FundedFinanceController.prototype.visitVnpay,
      FundedFinanceController.prototype.soloWallet,
      FundedFinanceController.prototype.visitWallet,
    ];
    for (const route of paymentRoutes) expect(bucketOf(route)).toBe('user-payment-init');

    expect(bucketOf(VnpayController.prototype.ipn)).toBeUndefined();
    expect(guardsOf(AuthController.prototype.register).some((guard) => guard === ThrottlerGuard)).toBe(true);
    expect(bucketOf(AuthController.prototype.register)).toBeUndefined();
    expect(guardsOf(AiDiagnosisController.prototype.analyze).map(guardName)).toContain('AiThrottlerGuard');
    expect(bucketOf(AiDiagnosisController.prototype.analyze)).toBeUndefined();
  });

  it('keys shared booking bursts by authenticated actor and returns Retry-After on 429', () => {
    const soloGuard = riskGuardOf(BookingsController.prototype.create);
    const groupGuard = riskGuardOf(VisitGroupsController.prototype.create);
    expect(soloGuard).toBeDefined();
    expect(groupGuard).toBeDefined();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T02:30:00.000Z'));
    try {
      const sameNat = '203.0.113.8';
      for (let request = 0; request < 20; request += 1) {
        const handler = request % 2 === 0
          ? BookingsController.prototype.create
          : VisitGroupsController.prototype.create;
        expect(soloGuard!.canActivate(httpContext(handler, { user: { id: 'customer-a' }, ip: sameNat }))).toBe(true);
      }

      expect(groupGuard!.canActivate(httpContext(VisitGroupsController.prototype.create, {
        user: { id: 'customer-b' }, ip: sameNat,
      }))).toBe(true);

      const response = { setHeader: vi.fn() };
      let rateLimitError: unknown;
      try {
        soloGuard!.canActivate(httpContext(BookingsController.prototype.create, {
          user: { id: 'customer-a' }, ip: sameNat,
        }, response));
      } catch (error) {
        rateLimitError = error;
      }
      expect(rateLimitError).toBeInstanceOf(HttpException);
      expect((rateLimitError as HttpException).getStatus()).toBe(429);
      expect((rateLimitError as HttpException).message).toMatch(/too many requests/i);
      expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '600');

      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(groupGuard!.canActivate(httpContext(VisitGroupsController.prototype.create, {
        user: { id: 'customer-a' }, ip: sameNat,
      }))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not trust caller-supplied X-Forwarded-For for anonymous IP fallback', () => {
    const guard = riskGuardOf(BookingsController.prototype.create);
    expect(guard).toBeDefined();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T03:00:00.000Z'));
    try {
      for (let request = 0; request < 20; request += 1) {
        expect(guard!.canActivate(httpContext(BookingsController.prototype.create, {
          ip: '203.0.113.12',
          headers: { 'x-forwarded-for': `198.51.100.${request + 1}` },
        }))).toBe(true);
      }
      expect(() => guard!.canActivate(httpContext(BookingsController.prototype.create, {
        ip: '203.0.113.12',
        headers: { 'x-forwarded-for': '192.0.2.99' },
      }))).toThrowError(/too many requests/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('guards upload and message mutations, while socket typing/call pressure is actor-scoped', async () => {
    expect(bucketOf(MediaController.prototype.uploadBookingPhoto)).toBe('media-upload');
    expect(bucketOf(MediaController.prototype.uploadBookingVideo)).toBe('media-video-upload');
    expect(bucketOf(MediaController.prototype.uploadFile)).toBe('media-upload');
    expect(bucketOf(ConversationsController.prototype.send)).toBe('message-write');
    expect(bucketOf(ConversationsController.prototype.sendAttachment)).toBe('message-attachment');
    expect(bucketOf(MessagesController.prototype.edit)).toBe('message-write');
    expect(bucketOf(MessagesController.prototype.remove)).toBe('message-write');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T04:00:00.000Z'));
    try {
      const emit = vi.fn();
      const gateway = Object.create(MessagingGateway.prototype) as unknown as {
        messagingService: { isMember: ReturnType<typeof vi.fn>; resolveCallPeer: ReturnType<typeof vi.fn> };
        onTyping: (socket: never, data: { conversationId: string }) => Promise<void>;
        onCallInvite: (socket: never, data: { conversationId: string }) => Promise<void>;
      };
      gateway.messagingService = {
        isMember: vi.fn().mockResolvedValue(true),
        resolveCallPeer: vi.fn().mockResolvedValue(null),
      };
      const actor = { id: 'socket-customer', role: 'customer' };
      const socket = {
        data: { user: actor },
        to: vi.fn(() => ({ emit })),
      };

      for (let event = 0; event < 60; event += 1) {
        await gateway.onTyping(socket as never, { conversationId: 'conversation-1' });
      }
      await gateway.onTyping({ ...socket, data: { user: actor } } as never, { conversationId: 'conversation-2' });
      expect(emit).toHaveBeenCalledTimes(60);

      for (let event = 0; event < 10; event += 1) {
        await gateway.onCallInvite(socket as never, { conversationId: 'conversation-1' });
      }
      await gateway.onCallInvite({ ...socket, data: { user: actor } } as never, { conversationId: 'conversation-2' });
      expect(gateway.messagingService.resolveCallPeer).toHaveBeenCalledTimes(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
