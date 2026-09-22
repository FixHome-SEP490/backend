import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

/** Public AI advice stays anonymous; saving against a Booking requires JWT. */
@Injectable()
export class AiDiagnosisBookingAuthGuard extends JwtAuthGuard {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ body?: { bookingId?: unknown } }>();
    if (!Object.prototype.hasOwnProperty.call(request.body ?? {}, 'bookingId')) return true;
    return super.canActivate(context);
  }
}