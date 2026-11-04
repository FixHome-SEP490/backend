import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** DEV pilot ceilings only. Tune this map from DEV 429/false-positive metrics before wider rollout. */
export const RISK_RATE_LIMITS = {
  'booking-create': { limit: 20, windowMs: 10 * MINUTE_MS },
  'booking-consultation': { limit: 10, windowMs: HOUR_MS },
  'user-payment-init': { limit: 30, windowMs: MINUTE_MS },
  'media-upload': { limit: 30, windowMs: MINUTE_MS },
  'media-video-upload': { limit: 6, windowMs: HOUR_MS },
  'message-write': { limit: 60, windowMs: MINUTE_MS },
  'message-attachment': { limit: 12, windowMs: MINUTE_MS },
  'socket-typing': { limit: 60, windowMs: 10_000 },
  'socket-call-invite': { limit: 10, windowMs: MINUTE_MS },
} as const;

export type RiskRateLimitBucket = keyof typeof RISK_RATE_LIMITS;

const RISK_RATE_LIMIT_METADATA = 'fixhome:risk-limit-bucket';
const CLEANUP_INTERVAL_MS = MINUTE_MS;

interface Counter {
  count: number;
  resetAt: number;
}

interface Decision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/** Process-local fixed windows; no proxy header is parsed here. */
class InMemoryRiskRateLimiter {
  private readonly counters = new Map<string, Counter>();
  private nextCleanupAt = 0;

  consume(bucket: RiskRateLimitBucket, subject: string, now = Date.now()): Decision {
    this.removeExpired(now);

    const policy = RISK_RATE_LIMITS[bucket];
    const key = `${bucket}:${subject}`;
    const current = this.counters.get(key);
    if (!current || current.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + policy.windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (current.count >= policy.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
      };
    }

    current.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private removeExpired(now: number): void {
    if (now < this.nextCleanupAt) return;
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) this.counters.delete(key);
    }
    this.nextCleanupAt = now + CLEANUP_INTERVAL_MS;
  }
}

const sharedLimiter = new InMemoryRiskRateLimiter();

/** Shared by the HTTP guard and authenticated Socket.IO event handlers. */
export function consumeRiskRateLimit(
  bucket: RiskRateLimitBucket,
  subject: string,
  now = Date.now(),
): Decision {
  return sharedLimiter.consume(bucket, subject, now);
}

@Injectable()
export class RiskRateLimitGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const bucket = Reflect.getMetadata(
      RISK_RATE_LIMIT_METADATA,
      context.getHandler(),
    ) as RiskRateLimitBucket | undefined;
    if (!bucket) return true;

    const request = context.switchToHttp().getRequest<{
      user?: { id?: unknown };
      ip?: unknown;
      socket?: { remoteAddress?: unknown };
    }>();
    const response = context.switchToHttp().getResponse<{
      setHeader?: (name: string, value: string) => void;
    }>();
    const userId = request?.user?.id;
    const ip = request?.ip || request?.socket?.remoteAddress || 'unknown';
    const subject = typeof userId === 'string' && userId
      ? `user:${userId}`
      : `ip:${String(ip)}`;
    const decision = consumeRiskRateLimit(bucket, subject);

    if (!decision.allowed) {
      response?.setHeader?.('Retry-After', String(decision.retryAfterSeconds));
      throw new HttpException(
        'Too many requests. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}

/** Opt in per route; auth guards must be declared below this decorator to run first. */
export function RiskLimit(bucket: RiskRateLimitBucket): MethodDecorator {
  return applyDecorators(
    SetMetadata(RISK_RATE_LIMIT_METADATA, bucket),
    UseGuards(new RiskRateLimitGuard()),
  );
}
