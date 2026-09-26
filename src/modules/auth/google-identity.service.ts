// src/modules/auth/google-identity.service.ts
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';

/** Những gì ta thực sự cần từ Google, sau khi đã xác thực chữ ký. */
export interface GoogleProfile {
  /** `sub` — định danh ổn định, không đổi khi người dùng đổi địa chỉ Gmail. */
  googleId: string;
  email: string;
  emailVerified: boolean;
  fullName: string;
  avatarUrl: string | null;
}

/**
 * Lớp duy nhất nói chuyện với Google.
 *
 * Tách riêng khỏi AuthService vì hai việc khác nhau hẳn: ở đây là giao thức
 * OAuth và kiểm chữ ký, còn bên kia là nghiệp vụ tài khoản FixHome. Nhờ vậy
 * test nghiệp vụ không cần mạng.
 *
 * Hai đường vào, cùng đích đến là một GoogleProfile đã xác thực:
 *
 * Web dùng Google Identity Services ngay trong trình duyệt, nhận sẵn một ID
 * token rồi gửi về đây — chỉ cần CLIENT_ID, không đụng tới secret.
 *
 * Mobile không đi đường đó được, vì Google không chấp nhận địa chỉ quay về kiểu
 * `exp://192.168.x.x:8081` của Expo Go. Thay vào đó app mở trình duyệt trỏ vào
 * backend, backend mới là bên trao đổi mã với Google bằng secret của mình. Cách
 * này còn tránh được ràng buộc vân tay SHA-1 của SDK gốc — thứ buộc mỗi máy lập
 * trình viên phải tự khai báo riêng trong Google Console.
 */
@Injectable()
export class GoogleIdentityService {
  private readonly logger = new Logger(GoogleIdentityService.name);

  constructor(private readonly configService: ConfigService) {}

  /** Chưa điền credentials thì mọi endpoint Google phải từ chối rõ ràng. */
  get isConfigured(): boolean {
    return Boolean(this.clientId && this.clientSecret);
  }

  private get clientId(): string | undefined {
    return this.configService.get<string>('GOOGLE_CLIENT_ID');
  }

  private get clientSecret(): string | undefined {
    return this.configService.get<string>('GOOGLE_CLIENT_SECRET');
  }

  get callbackUrl(): string {
    return this.configService.getOrThrow<string>('GOOGLE_CALLBACK_URL');
  }

  private assertConfigured(): void {
    if (this.isConfigured) return;
    throw new ServiceUnavailableException(
      'Đăng nhập Google chưa được cấu hình trên máy chủ. Cần đặt GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET trong .env.',
    );
  }

  private createClient(): OAuth2Client {
    this.assertConfigured();
    return new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      redirectUri: this.callbackUrl,
    });
  }

  /**
   * Địa chỉ trang đồng ý của Google.
   *
   * `state` do phía gọi ký sẵn; Google trả lại nguyên vẹn nên ta dùng nó vừa để
   * chống CSRF vừa để nhớ xem phải quay về đâu.
   */
  buildAuthorizationUrl(state: string): string {
    const client = this.createClient();
    return client.generateAuthUrl({
      scope: ['openid', 'email', 'profile'],
      state,
      // Chỉ cần danh tính, không đụng tới dữ liệu nào của người dùng, nên không
      // xin refresh token của Google.
      access_type: 'online',
      prompt: 'select_account',
    });
  }

  /** Đường của mobile: đổi mã uỷ quyền lấy hồ sơ. */
  async exchangeCode(code: string): Promise<GoogleProfile> {
    const client = this.createClient();
    let idToken: string | null | undefined;
    try {
      const { tokens } = await client.getToken(code);
      idToken = tokens.id_token;
    } catch (error) {
      this.logger.warn(
        `Không đổi được mã uỷ quyền của Google: ${(error as Error).message}`,
      );
      throw new UnauthorizedException('Mã đăng nhập Google không hợp lệ');
    }
    if (!idToken) {
      throw new UnauthorizedException('Google không trả về ID token');
    }
    return this.verifyIdToken(idToken);
  }

  /**
   * Đường của web, và cũng là bước cuối của đường mobile.
   *
   * `verifyIdToken` kiểm chữ ký, hạn dùng, và quan trọng nhất là `aud` phải
   * đúng CLIENT_ID của ta — thiếu bước này thì một token do Google cấp cho ứng
   * dụng khác cũng lọt vào được.
   */
  async verifyIdToken(idToken: string): Promise<GoogleProfile> {
    const client = this.createClient();
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: this.clientId,
      });
      payload = ticket.getPayload();
    } catch (error) {
      this.logger.warn(
        `ID token của Google không hợp lệ: ${(error as Error).message}`,
      );
      throw new UnauthorizedException('Phiên đăng nhập Google không hợp lệ');
    }

    if (!payload?.sub || !payload.email) {
      throw new UnauthorizedException(
        'Tài khoản Google không cung cấp đủ thông tin định danh',
      );
    }

    // Google có thể trả về một email chưa xác minh (tài khoản Workspace tự dựng
    // chẳng hạn). Liên kết một email như thế vào tài khoản sẵn có là mở đường
    // chiếm tài khoản, nên chặn ngay tại đây.
    if (payload.email_verified !== true) {
      throw new UnauthorizedException(
        'Email của tài khoản Google này chưa được xác minh',
      );
    }

    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase().trim(),
      emailVerified: true,
      fullName: (payload.name || payload.email.split('@')[0]).trim(),
      avatarUrl: payload.picture ?? null,
    };
  }
}
