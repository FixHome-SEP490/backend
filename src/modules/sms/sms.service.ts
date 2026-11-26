// src/modules/sms/sms.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Phone OTP through Twilio Verify. Twilio generates, stores, expires and
 * rate-limits the code, so nothing is kept in our database.
 * A trial account only delivers to verified numbers.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(private readonly configService: ConfigService) {}

  /** 0394060729 -> +84394060729 */
  toE164(phone: string): string {
    const p = phone.replace(/[\s.-]/g, '');
    if (p.startsWith('+')) return p;
    if (p.startsWith('0')) return `+84${p.slice(1)}`;
    return `+${p}`;
  }

  async sendOtp(phone: string): Promise<void> {
    // A trial account cannot rename its Verify service, so the brand name goes with every request.
    await this.call('Verifications', { To: this.toE164(phone), Channel: 'sms', CustomFriendlyName: 'FixHome' });
  }

  /** true when Twilio approves the code; false when it is wrong, expired or already used. */
  async checkOtp(phone: string, code: string): Promise<boolean> {
    const res = await this.call('VerificationCheck', {
      To: this.toE164(phone),
      Code: code.trim(),
    });
    return res.status === 'approved';
  }

  private async call(path: string, body: Record<string, string>): Promise<{ status?: string }> {
    const sid = this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const token = this.configService.get<string>('TWILIO_AUTH_TOKEN');
    const service = this.configService.get<string>('TWILIO_VERIFY_SID');
    if (!sid || !token || !service) {
      throw new ServiceUnavailableException('SMS chưa được cấu hình (TWILIO_*)');
    }

    const res = await fetch(`https://verify.twilio.com/v2/Services/${service}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body),
    });
    const json = (await res.json().catch(() => ({}))) as { status?: string; message?: string };

    if (res.ok) return json;
    this.logger.error(`Twilio ${path} ${res.status}: ${json.message}`);
    // A check on a code that expired or was already used answers 404.
    if (path === 'VerificationCheck' && res.status === 404) return { status: 'expired' };
    if (res.status === 429) throw new BadRequestException('Gửi quá nhiều lần, vui lòng thử lại sau');
    throw new ServiceUnavailableException('Không gửi được SMS, vui lòng thử lại sau');
  }
}
