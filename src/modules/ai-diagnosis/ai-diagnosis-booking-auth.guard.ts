import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

/**
 * Public AI advice stays anonymous; saving against a Booking requires JWT.
 *
 * When a caller does send a token, it is read so the conversation summary can
 * be tied to that customer, but a missing or stale token never blocks advice.
 */
@Injectable()
export class AiDiagnosisBookingAuthGuard extends JwtAuthGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      body?: { bookingId?: unknown };
      headers?: Record<string, unknown>;
    }>();
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, 'bookingId')) {
      return (await super.canActivate(context)) as boolean;
    }
    if (!request.headers?.authorization) return true;
    try {
      await super.canActivate(context);
    } catch {
      // Anonymous advice: the token was not usable, the question still is.
    }
    return true;
  }
}
