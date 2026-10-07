// src/modules/auth/google-redirect.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

const STATE_PURPOSE = 'google_oauth_state';

/**
 * Whether a redirect falls under an allowed prefix, compared as URLs. A text
 * prefix check accepted "http://localhost:5173@evil.com/cb", which a browser
 * sends to evil.com, and "https://fixhome.vn.evil.com". The scheme must match,
 * the host and port must match when the prefix names one (Expo's "exp://" names
 * none, since every developer's LAN address differs), credentials are never
 * allowed, and the path must start with the prefix's path.
 */
export function redirectMatches(redirect: string, prefix: string): boolean {
  let target: URL;
  let allowed: URL;
  try {
    target = new URL(redirect);
    allowed = new URL(prefix);
  } catch {
    return false;
  }
  if (target.protocol !== allowed.protocol) return false;
  if (target.username || target.password) return false;
  if (allowed.host && target.host !== allowed.host) return false;
  const basePath = allowed.pathname.replace(/\/+$/, '');
  if (basePath && basePath !== '/' && !(target.pathname === basePath || target.pathname.startsWith(`${basePath}/`))) {
    return false;
  }
  return true;
}

/**
 * Giữ hai thứ của vòng đi vòng về qua Google: app muốn quay về đâu, và làm sao
 * biết lượt quay về đúng là lượt ta đã gửi đi.
 *
 * Địa chỉ quay về không thể liệt kê cứng, vì Expo Go sinh nó lúc chạy theo IP
 * mạng LAN của từng máy — `exp://192.168.1.8:8081/--/auth/google` trên máy này,
 * IP khác trên máy khác. Đó cũng chính là lý do ta không đẩy địa chỉ này cho
 * Google: Google chỉ biết đúng một địa chỉ cố định của backend, khai một lần
 * cho cả đội.
 *
 * Nhưng nhận bừa mọi địa chỉ thì hỏng: kẻ tấn công chỉ cần dụ nạn nhân mở
 * `/auth/google/start?redirect=https://ke-tan-cong.example` là mã bàn giao bay
 * thẳng sang máy họ. Nên ta kiểm theo danh sách tiền tố cho phép.
 */
@Injectable()
export class GoogleRedirectService {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  private get allowedPrefixes(): string[] {
    return this.configService
      .getOrThrow<string>('GOOGLE_ALLOWED_APP_REDIRECTS')
      .split(',')
      .map((prefix) => prefix.trim())
      .filter(Boolean);
  }

  private get defaultRedirect(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:5173'
    );
  }

  /**
   * Bỏ trống thì đưa về web frontend. Có giá trị thì phải khớp một tiền tố cho
   * phép, và phải là địa chỉ đọc được — chuỗi rác lọt qua đây sẽ thành một
   * lệnh chuyển hướng hỏng ở cuối luồng, lúc đó rất khó lần ra nguyên nhân.
   */
  validateAppRedirect(redirect?: string): string {
    if (!redirect) return this.defaultRedirect;

    const allowed = this.allowedPrefixes.some((prefix) =>
      redirectMatches(redirect, prefix),
    );
    if (!allowed) {
      throw new BadRequestException(
        'Địa chỉ quay về không nằm trong danh sách được phép',
      );
    }

    try {
      // eslint-disable-next-line no-new
      new URL(redirect);
    } catch {
      throw new BadRequestException('Địa chỉ quay về không hợp lệ');
    }

    return redirect;
  }

  /**
   * Google trả `state` lại nguyên vẹn, nên ta ký nó thành JWT ngắn hạn: vừa
   * mang được địa chỉ quay về, vừa chứng minh lượt quay về này xuất phát từ ta
   * chứ không phải ai đó tự gọi thẳng vào địa chỉ callback.
   */
  async signState(appRedirect: string): Promise<string> {
    return this.jwtService.signAsync(
      { redirect: appRedirect, purpose: STATE_PURPOSE },
      {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: '10m',
        algorithm: 'HS256',
      },
    );
  }

  async readState(state?: string): Promise<string> {
    if (!state) {
      throw new BadRequestException('Thiếu tham số state của Google');
    }
    let payload: { redirect?: string; purpose?: string };
    try {
      payload = await this.jwtService.verifyAsync(state, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        algorithms: ['HS256'],
      });
    } catch {
      throw new BadRequestException('Phiên đăng nhập Google đã hết hạn');
    }
    if (payload.purpose !== STATE_PURPOSE || !payload.redirect) {
      throw new BadRequestException('Tham số state không hợp lệ');
    }
    // Kiểm lại lần nữa: danh sách cho phép có thể đã bị siết lại kể từ lúc ký.
    return this.validateAppRedirect(payload.redirect);
  }

  /**
   * Gắn kết quả vào địa chỉ quay về.
   *
   * Dùng `URL` để ghép thay vì nối chuỗi, nhờ vậy địa chỉ vốn đã có sẵn tham số
   * không bị hỏng, và giá trị được mã hoá đúng.
   */
  buildAppCallbackUrl(
    appRedirect: string,
    params: Record<string, string>,
  ): string {
    const url = new URL(appRedirect);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }
}
