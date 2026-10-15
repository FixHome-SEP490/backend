// src/modules/ai-diagnosis/ai-throttler.guard.ts
import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * How often one customer may ask the assistant.
 *
 * Every message reaches a model on a rented GPU, and one card serves about
 * fifty people at once before replies slow past what a customer will wait for
 * (measured 16/10/2026). A single person scripting messages, or a page stuck
 * in a retry loop, would take that capacity from everybody else.
 *
 * Counted per signed-in customer, so a household behind one router is not
 * throttled as one person, and per IP for anonymous advice. Runs after
 * AiDiagnosisBookingAuthGuard, which is what puts the customer on the request.
 */
@Injectable()
export class AiThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const userId = req?.user?.id;
    if (typeof userId === 'string' && userId) return `user:${userId}`;
    const forwarded = req?.ips?.length ? req.ips[0] : undefined;
    return `ip:${forwarded || req?.ip || 'unknown'}`;
  }
}

/** Per minute. A person typing does not come close; a loop does. */
export const AI_ANALYZE_PER_MINUTE = 20;
export const AI_ASK_PER_MINUTE = 30;
