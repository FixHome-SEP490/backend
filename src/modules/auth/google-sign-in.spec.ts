// src/modules/auth/google-sign-in.spec.ts
//
// Luồng đăng nhập Google, kiểm ở mức đơn vị: không gọi mạng, không chạm DB.
//
// Quyết định nghiệp vụ được khoá lại ở đây là "email trùng thì tự động liên
// kết" — PO chốt ngày 26/09/2026. Nếu sau này đổi ý thì sửa cả test lẫn
// AuthService.resolveGoogleUser cùng lúc.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { GoogleRedirectService } from './google-redirect.service';
import { GoogleIdentityService } from './google-identity.service';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { Role, AccountStatus, AuthProvider } from '../../shared/enums';

const GOOGLE_PROFILE = {
  googleId: 'google-sub-1',
  email: 'nguoidung@gmail.com',
  emailVerified: true,
  fullName: 'Nguyen Van A',
  avatarUrl: 'https://lh3.googleusercontent.com/anh',
};

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'nguoidung@gmail.com',
    passwordHash: 'hash-cu',
    googleId: null,
    authProvider: AuthProvider.LOCAL,
    fullName: 'Nguyen Van A',
    phoneNumber: '0912345678',
    role: Role.CUSTOMER,
    status: AccountStatus.ACTIVE,
    isActive: true,
    isEmailVerified: false,
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    refreshTokens: [],
    ...overrides,
  } as User;
}

describe('Đăng nhập Google — nghiệp vụ tài khoản', () => {
  let authService: AuthService;
  let userRepository: any;
  let saved: User[];

  /** Bảng users giả lập; findOne trả theo đúng điều kiện được hỏi. */
  let table: User[];

  beforeEach(() => {
    table = [];
    saved = [];

    userRepository = {
      findOne: vi.fn(({ where }: any) => {
        const clauses = Array.isArray(where) ? where : [where];
        for (const clause of clauses) {
          const found = table.find((row) =>
            Object.entries(clause).every(
              ([key, value]) => (row as any)[key] === value,
            ),
          );
          if (found) return Promise.resolve(found);
        }
        return Promise.resolve(null);
      }),
      create: vi.fn((data: Partial<User>) => ({ id: 'user-moi', ...data })),
      save: vi.fn((data: User) => {
        saved.push(data);
        const index = table.findIndex((row) => row.id === data.id);
        if (index >= 0) table[index] = { ...table[index], ...data };
        else table.push(data as User);
        return Promise.resolve(data);
      }),
    };

    const refreshTokenRepository = {
      create: vi.fn((data: any) => ({ id: 'token-1', ...data })),
      save: vi.fn((data: any) => Promise.resolve(data)),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
    };
    const otpRepository = {
      findOne: vi.fn(),
      create: vi.fn(),
      save: vi.fn(),
      update: vi.fn(),
    };

    const jwtService = {
      sign: vi.fn().mockReturnValue('token-gia'),
      decode: vi
        .fn()
        .mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 604800 }),
      signAsync: vi.fn().mockResolvedValue('ma-ban-giao'),
      verifyAsync: vi.fn(),
    };

    const configService: any = {
      get: vi.fn((key: string) =>
        key === 'JWT_ACCESS_SECRET'
          ? 'access-secret'
          : key === 'JWT_REFRESH_SECRET'
            ? 'refresh-secret'
            : key === 'JWT_ACCESS_EXPIRES_IN'
              ? '15m'
              : key === 'JWT_REFRESH_EXPIRES_IN'
                ? '7d'
                : undefined,
      ),
    };
    configService.getOrThrow = configService.get;

    const manager = {
      getRepository: (entity: unknown) => {
        if (entity === User) return userRepository;
        if (entity === RefreshToken) return refreshTokenRepository;
        return otpRepository;
      },
    };
    userRepository.manager = {
      transaction: (fn: (m: typeof manager) => unknown) => fn(manager),
    };

    authService = new AuthService(
      userRepository,
      otpRepository as any,
      jwtService as any,
      configService,
      { sendRegisterOtp: vi.fn(), sendPasswordResetOtp: vi.fn() } as any,
    );
  });

  it('tạo tài khoản CUSTOMER mới, không mật khẩu, kích hoạt luôn', async () => {
    const result = await authService.loginWithGoogle(GOOGLE_PROFILE);

    const created = saved[0];
    expect(created.passwordHash).toBeNull();
    expect(created.googleId).toBe('google-sub-1');
    expect(created.authProvider).toBe(AuthProvider.GOOGLE);
    expect(created.role).toBe(Role.CUSTOMER);
    // Google đã xác minh email rồi nên không bắt nhập OTP thêm lần nữa.
    expect(created.status).toBe(AccountStatus.ACTIVE);
    expect(created.isEmailVerified).toBe(true);
    expect(result.accessToken).toBeTruthy();
  });

  it('tự động liên kết khi email đã có tài khoản mật khẩu', async () => {
    table.push(makeUser());

    await authService.loginWithGoogle(GOOGLE_PROFILE);

    const linked = saved[0];
    expect(linked.googleId).toBe('google-sub-1');
    // Mật khẩu cũ vẫn dùng được nên tài khoản vẫn là LOCAL.
    expect(linked.authProvider).toBe(AuthProvider.LOCAL);
    expect(linked.passwordHash).toBe('hash-cu');
    expect(linked.isEmailVerified).toBe(true);
  });

  it('không ghi đè khi email đã gắn với một tài khoản Google khác', async () => {
    table.push(makeUser({ googleId: 'google-sub-khac' }));

    await expect(authService.loginWithGoogle(GOOGLE_PROFILE)).rejects.toThrow(
      ConflictException,
    );
  });

  it('tài khoản bị khoá không lách được bằng nút Google', async () => {
    table.push(makeUser({ status: AccountStatus.SUSPENDED }));

    await expect(authService.loginWithGoogle(GOOGLE_PROFILE)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('tìm theo googleId trước, nên đổi địa chỉ Gmail vẫn vào đúng tài khoản', async () => {
    table.push(
      makeUser({
        id: 'user-cu',
        email: 'dia-chi-cu@gmail.com',
        googleId: 'google-sub-1',
      }),
    );

    await authService.loginWithGoogle(GOOGLE_PROFILE);

    expect(saved[0].id).toBe('user-cu');
  });

  it('chỉ điền avatar từ Google khi tài khoản chưa có ảnh', async () => {
    table.push(makeUser({ avatarUrl: 'https://anh-nguoi-dung-tu-tai.png' }));

    await authService.loginWithGoogle(GOOGLE_PROFILE);

    expect(saved[0].avatarUrl).toBe('https://anh-nguoi-dung-tu-tai.png');
  });

  it('đăng nhập mật khẩu vào tài khoản chỉ có Google thì báo bấm nút Google', async () => {
    table.push(
      makeUser({
        passwordHash: null,
        googleId: 'google-sub-1',
        authProvider: AuthProvider.GOOGLE,
      }),
    );

    // Không được ném lỗi bcrypt "data and hash arguments required" thành 500.
    await expect(
      authService.login({
        email: 'nguoidung@gmail.com',
        password: 'BatKyMatKhauNao123!',
      } as any),
    ).rejects.toThrow(/Google/);
  });
});

describe('GoogleRedirectService — chặn lái token đi chỗ khác', () => {
  let service: GoogleRedirectService;
  let jwtService: any;

  beforeEach(() => {
    const configService: any = {
      get: vi.fn((key: string) =>
        key === 'FRONTEND_URL' ? 'http://localhost:5173' : undefined,
      ),
      getOrThrow: vi.fn((key: string) => {
        if (key === 'GOOGLE_ALLOWED_APP_REDIRECTS')
          return 'exp://,fixhome://,http://localhost:5173';
        if (key === 'JWT_ACCESS_SECRET') return 'access-secret';
        throw new Error(`thiếu ${key}`);
      }),
    };
    jwtService = { signAsync: vi.fn(), verifyAsync: vi.fn() };
    service = new GoogleRedirectService(configService, jwtService);
  });

  it('nhận địa chỉ Expo Go dù IP mỗi máy mỗi khác', () => {
    expect(
      service.validateAppRedirect('exp://192.168.1.8:8081/--/auth/google'),
    ).toBe('exp://192.168.1.8:8081/--/auth/google');
    expect(
      service.validateAppRedirect('exp://10.0.0.99:8081/--/auth/google'),
    ).toBe('exp://10.0.0.99:8081/--/auth/google');
  });

  it('từ chối địa chỉ ngoài danh sách cho phép', () => {
    expect(() =>
      service.validateAppRedirect('https://ke-tan-cong.example/thu-token'),
    ).toThrow(/không nằm trong danh sách/);
  });

  it('bỏ trống thì đưa về web frontend', () => {
    expect(service.validateAppRedirect()).toBe('http://localhost:5173');
  });

  it('từ chối state mang địa chỉ không còn được phép', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      purpose: 'google_oauth_state',
      redirect: 'https://ke-tan-cong.example',
    });

    await expect(service.readState('state-gia')).rejects.toThrow(
      /không nằm trong danh sách/,
    );
  });

  it('từ chối state không đúng mục đích', async () => {
    jwtService.verifyAsync.mockResolvedValue({
      purpose: 'mot-thu-khac',
      redirect: 'exp://192.168.1.8:8081',
    });

    await expect(service.readState('state-gia')).rejects.toThrow(
      /không hợp lệ/,
    );
  });

  it('ghép tham số mà không làm hỏng địa chỉ vốn đã có sẵn tham số', () => {
    const url = service.buildAppCallbackUrl(
      'exp://192.168.1.8:8081/--/auth?buoc=1',
      { code: 'ma bàn giao/có ký tự lạ' },
    );

    expect(url).toContain('buoc=1');
    expect(url).toContain('code=ma+b%C3%A0n+giao%2Fc%C3%B3+k%C3%BD+t%E1%BB%B1+l%E1%BA%A1');
  });
});

describe('GoogleIdentityService — chưa cấu hình thì từ chối rõ ràng', () => {
  it('báo 503 kèm tên biến cần đặt, thay vì lỗi khó hiểu', () => {
    const configService: any = {
      get: vi.fn().mockReturnValue(undefined),
      getOrThrow: vi.fn().mockReturnValue('http://localhost:3000/cb'),
    };
    const service = new GoogleIdentityService(configService);

    expect(service.isConfigured).toBe(false);
    expect(() => service.buildAuthorizationUrl('state')).toThrow(
      ServiceUnavailableException,
    );
  });

  it('coi là đã cấu hình khi có đủ cả hai giá trị', () => {
    const configService: any = {
      get: vi.fn((key: string) =>
        key === 'GOOGLE_CLIENT_ID'
          ? 'client-id'
          : key === 'GOOGLE_CLIENT_SECRET'
            ? 'client-secret'
            : undefined,
      ),
      getOrThrow: vi.fn().mockReturnValue('http://localhost:3000/cb'),
    };

    expect(new GoogleIdentityService(configService).isConfigured).toBe(true);
  });
});

describe('Controller — chuyển hướng phải đi thẳng, không qua phong bì', () => {
  // Lỗi đã gặp thật: dùng @Redirect() thì TransformInterceptor bọc giá trị trả
  // về thành { success, data }, Nest không còn thấy khoá `url` ở cấp ngoài nên
  // chuyển hướng tới địa chỉ rỗng — phản hồi là HTTP 200 với nội dung
  // "OK. Redirecting to " bỏ lửng. Cầm Response trực tiếp thì mới đúng.
  const makeController = (overrides: {
    identity?: Partial<GoogleIdentityService>;
    redirect?: Partial<GoogleRedirectService>;
    auth?: Partial<AuthService>;
  }) => {
    const identity = {
      buildAuthorizationUrl: vi.fn().mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?x=1'),
      exchangeCode: vi.fn(),
      ...overrides.identity,
    } as unknown as GoogleIdentityService;
    const redirect = {
      validateAppRedirect: vi.fn((value?: string) => value ?? 'http://localhost:5173'),
      signState: vi.fn().mockResolvedValue('state-da-ky'),
      readState: vi.fn().mockResolvedValue('exp://192.168.1.8:8081/--/auth'),
      buildAppCallbackUrl: vi.fn(
        (base: string, params: Record<string, string>) =>
          `${base}?${new URLSearchParams(params).toString()}`,
      ),
      ...overrides.redirect,
    } as unknown as GoogleRedirectService;
    const auth = {
      createGoogleHandoffCode: vi.fn().mockResolvedValue('ma-ban-giao'),
      ...overrides.auth,
    } as unknown as AuthService;

    return new AuthController(auth, identity, redirect);
  };

  const makeRes = () => ({ redirect: vi.fn() }) as any;

  it('/google/start chuyển thẳng sang Google', async () => {
    const controller = makeController({});
    const res = makeRes();

    await controller.startGoogleAuthorization(
      { redirect: 'exp://192.168.1.8:8081/--/auth' } as any,
      res,
    );

    expect(res.redirect).toHaveBeenCalledWith(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    );
  });

  it('/google/callback đưa mã bàn giao về đúng app', async () => {
    const controller = makeController({
      identity: { exchangeCode: vi.fn().mockResolvedValue(GOOGLE_PROFILE) } as any,
    });
    const res = makeRes();

    await controller.handleGoogleCallback(res, 'ma-uy-quyen', 'state-da-ky');

    expect(res.redirect).toHaveBeenCalledWith(
      'exp://192.168.1.8:8081/--/auth?code=ma-ban-giao',
    );
  });

  it('người dùng bấm huỷ thì vẫn được đưa về app kèm lý do', async () => {
    const controller = makeController({});
    const res = makeRes();

    await controller.handleGoogleCallback(res, undefined, 'state-da-ky', 'access_denied');

    expect(res.redirect).toHaveBeenCalledWith(
      'exp://192.168.1.8:8081/--/auth?error=access_denied',
    );
  });

  it('lỗi nghiệp vụ cũng hiện trong app chứ không phải tab trình duyệt', async () => {
    const controller = makeController({
      identity: {
        exchangeCode: vi
          .fn()
          .mockRejectedValue(new Error('Account is locked or suspended')),
      } as any,
    });
    const res = makeRes();

    await controller.handleGoogleCallback(res, 'ma-uy-quyen', 'state-da-ky');

    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining('error=Account+is+locked+or+suspended'),
    );
  });
});

describe('Mã bàn giao của mobile', () => {
  let authService: AuthService;
  let jwtService: any;

  beforeEach(() => {
    jwtService = { verifyAsync: vi.fn(), signAsync: vi.fn(), sign: vi.fn(), decode: vi.fn() };
    const configService: any = {
      get: vi.fn().mockReturnValue('access-secret'),
      getOrThrow: vi.fn().mockReturnValue('access-secret'),
    };
    authService = new AuthService(
      { manager: { transaction: vi.fn() } } as any,
      {} as any,
      jwtService,
      configService,
      {} as any,
    );
  });

  it('từ chối token đúng chữ ký nhưng sai mục đích', async () => {
    // Mã bàn giao dùng chung khoá ký với access token, nên nếu bỏ kiểm
    // `purpose` thì một access token thường cũng đổi được thành phiên mới.
    jwtService.verifyAsync.mockResolvedValue({ sub: 'user-1', role: 'customer' });

    await expect(
      authService.exchangeGoogleHandoffCode('access-token-thuong'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('từ chối token hết hạn', async () => {
    jwtService.verifyAsync.mockRejectedValue(new Error('jwt expired'));

    await expect(
      authService.exchangeGoogleHandoffCode('token-het-han'),
    ).rejects.toThrow(/hết hạn|không hợp lệ/);
  });
});
