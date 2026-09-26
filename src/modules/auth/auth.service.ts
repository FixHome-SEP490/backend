// src/modules/auth/auth.service.ts
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash, randomInt, randomUUID } from 'crypto';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { OtpVerification } from './entities/otp-verification.entity';
import {
  Role,
  AccountStatus,
  OtpPurpose,
  AuthProvider,
} from '../../shared/enums';
import type { GoogleProfile } from './google-identity.service';

/**
 * Mã bàn giao của luồng Google dùng chung khoá ký với access token, nên nó
 * phải tự khai mục đích để không bị nhầm lẫn với một access token thường.
 */
const GOOGLE_HANDOFF_PURPOSE = 'google_handoff';
import { normalizePhone } from '../../shared/validation/input.transforms';
import { RbacService } from '../rbac/rbac.service';
import { MailService } from '../mail/mail.service';
import {
  RegisterDto,
  LoginDto,
  RefreshTokenDto,
  AuthResponseDto,
  TokenRefreshResponseDto,
  UserProfileDto,
  RegisterResponseDto,
  VerifyOtpDto,
  ResendOtpDto,
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto';

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User) private readonly userRepository: Repository<User>,
    @InjectRepository(OtpVerification)
    private readonly otpRepository: Repository<OtpVerification>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
    @Optional() private readonly rbacService?: RbacService,
  ) {}

  private async getPermissions(role: string): Promise<string[]> {
    if (!this.rbacService) return [];
    return this.rbacService.getPermissionsForRole(role);
  }

  private async generateAndSendOtp(
    email: string,
    purpose: OtpPurpose,
    fullName?: string,
    manager?: EntityManager,
  ): Promise<{ resendAvailableAt: Date }> {
    const otpRepo = manager
      ? manager.getRepository(OtpVerification)
      : this.otpRepository;

    const latestOtp = await otpRepo.findOne({
      where: { email, purpose, isUsed: false },
      order: { createdAt: 'DESC' },
    });

    const now = new Date();
    if (
      latestOtp &&
      latestOtp.resendAvailableAt > now &&
      latestOtp.expiresAt > now
    ) {
      const waitSeconds = Math.ceil(
        (latestOtp.resendAvailableAt.getTime() - now.getTime()) / 1000,
      );
      throw new BadRequestException(
        `Vui lòng đợi ${waitSeconds} giây trước khi yêu cầu mã OTP mới`,
      );
    }

    // Invalidate previous active OTPs for this email and purpose
    await otpRepo.update({ email, purpose, isUsed: false }, { isUsed: true });

    // Generate 6-digit OTP code
    const rawOtp = randomInt(100000, 1000000).toString();
    const codeHash = createHash('sha256').update(rawOtp).digest('hex');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes
    const resendAvailableAt = new Date(Date.now() + 60 * 1000); // 60s cooldown

    await otpRepo.save(
      otpRepo.create({
        email,
        codeHash,
        purpose,
        expiresAt,
        resendAvailableAt,
        attempts: 0,
        maxAttempts: 5,
        isUsed: false,
      }),
    );

    // Send email asynchronously
    if (purpose === OtpPurpose.REGISTER) {
      await this.mailService.sendRegisterOtp(email, rawOtp, fullName);
    } else if (purpose === OtpPurpose.RESET_PASSWORD) {
      await this.mailService.sendPasswordResetOtp(email, rawOtp, fullName);
    }

    return { resendAvailableAt };
  }

  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    const role = dto.role ?? Role.CUSTOMER;
    if (role !== Role.CUSTOMER)
      throw new BadRequestException(
        'Only Customer accounts can self-register. Technician accounts are created by Service Managers or Admin.',
      );
    const email = dto.email.toLowerCase().trim();
    const phoneNumber = dto.phoneNumber
      ? normalizePhone(dto.phoneNumber)
      : null;

    const existingUser = await this.userRepository.findOne({ where: { email } });
    if (existingUser) {
      if (existingUser.status === AccountStatus.ACTIVE) {
        throw new ConflictException('Email is already registered');
      }
      // If user exists with pending_verification, update info and resend OTP
      const passwordHash = await bcrypt.hash(dto.password, 12);
      existingUser.fullName = dto.fullName.trim();
      existingUser.phoneNumber = phoneNumber ?? existingUser.phoneNumber;
      existingUser.passwordHash = passwordHash;
      await this.userRepository.save(existingUser);
      await this.generateAndSendOtp(
        email,
        OtpPurpose.REGISTER,
        existingUser.fullName,
      );
      return {
        message:
          'Đăng ký tài khoản thành công. Vui lòng kiểm tra email để lấy mã OTP xác thực.',
        email,
        expiresInMinutes: 5,
      };
    }

    if (
      phoneNumber &&
      (await this.userRepository.findOne({ where: { phoneNumber } }))
    )
      throw new ConflictException('Phone number is already registered');

    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.userRepository.manager.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const user = await users.save(
        users.create({
          email,
          phoneNumber,
          passwordHash,
          fullName: dto.fullName.trim(),
          role,
          status: AccountStatus.PENDING_VERIFICATION,
          isActive: true,
          isEmailVerified: false,
        }),
      );
      await this.generateAndSendOtp(
        email,
        OtpPurpose.REGISTER,
        user.fullName,
        manager,
      );
    });

    return {
      message:
        'Đăng ký tài khoản thành công. Vui lòng kiểm tra email để lấy mã OTP xác thực.',
      email,
      expiresInMinutes: 5,
    };
  }

  async verifyRegisterOtp(dto: VerifyOtpDto): Promise<AuthResponseDto> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new NotFoundException('Không tìm thấy tài khoản với email này');
    }
    if (user.status === AccountStatus.ACTIVE && user.isEmailVerified) {
      throw new BadRequestException(
        'Tài khoản này đã được kích hoạt trước đó. Vui lòng đăng nhập.',
      );
    }

    const otpRecord = await this.otpRepository.findOne({
      where: { email, purpose: OtpPurpose.REGISTER, isUsed: false },
      order: { createdAt: 'DESC' },
    });

    if (!otpRecord) {
      throw new BadRequestException('Mã OTP không hợp lệ hoặc đã được sử dụng');
    }

    const now = new Date();
    if (otpRecord.expiresAt < now) {
      throw new BadRequestException(
        'Mã OTP đã hết hạn. Vui lòng yêu cầu gửi lại mã mới.',
      );
    }

    if (otpRecord.attempts >= otpRecord.maxAttempts) {
      throw new BadRequestException(
        'Mã OTP đã bị khóa do nhập sai quá nhiều lần. Vui lòng yêu cầu gửi lại mã mới.',
      );
    }

    const inputHash = createHash('sha256')
      .update(dto.otp.trim())
      .digest('hex');
    if (inputHash !== otpRecord.codeHash) {
      otpRecord.attempts += 1;
      await this.otpRepository.save(otpRecord);
      const remaining = otpRecord.maxAttempts - otpRecord.attempts;
      if (remaining <= 0) {
        throw new BadRequestException(
          'Mã OTP đã bị khóa do nhập sai quá 5 lần. Vui lòng bấm gửi lại mã mới.',
        );
      }
      throw new BadRequestException(
        `Mã OTP không chính xác. Bạn còn ${remaining} lần thử.`,
      );
    }

    return this.userRepository.manager.transaction(async (manager) => {
      await manager
        .getRepository(OtpVerification)
        .update(otpRecord.id, { isUsed: true });

      user.status = AccountStatus.ACTIVE;
      user.isEmailVerified = true;
      user.isActive = true;
      await manager.getRepository(User).save(user);

      const tokens = await this.issueTokens(
        user,
        manager,
        'Registration Verify Session',
      );
      const permissions = await this.getPermissions(user.role);
      return { ...tokens, user: UserProfileDto.fromUser(user, permissions) };
    });
  }

  async resendRegisterOtp(
    dto: ResendOtpDto,
  ): Promise<{ message: string; resendAvailableAt: Date }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new NotFoundException('Không tìm thấy tài khoản với email này');
    }
    if (user.status === AccountStatus.ACTIVE && user.isEmailVerified) {
      throw new BadRequestException(
        'Tài khoản này đã được kích hoạt. Vui lòng đăng nhập.',
      );
    }

    const { resendAvailableAt } = await this.generateAndSendOtp(
      email,
      OtpPurpose.REGISTER,
      user.fullName,
    );

    return {
      message: 'Mã OTP mới đã được gửi đến email của bạn.',
      resendAvailableAt,
    };
  }

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    if (
      dto.email &&
      dto.identifier &&
      dto.email.trim() !== dto.identifier.trim()
    )
      throw new BadRequestException('Use one login identifier');
    const identifier = (dto.identifier ?? dto.email)?.trim();
    if (!identifier)
      throw new BadRequestException('Login identifier is required');
    const user = await this.userRepository.findOne({
      where: [
        { email: identifier.toLowerCase() },
        { phoneNumber: normalizePhone(identifier) },
      ],
      select: ['id', 'passwordHash', 'status', 'isActive', 'authProvider'],
    });

    // Tài khoản tạo ra từ Google không có mật khẩu nào cả. Gọi thẳng
    // bcrypt.compare với NULL sẽ ném lỗi và nổi lên thành HTTP 500, nên phải
    // chặn trước. Câu trả lời nói rõ phải bấm nút nào, vì nếu chỉ trả "sai mật
    // khẩu" thì người dùng sẽ thử lại mãi một thứ họ chưa từng đặt.
    if (user && !user.passwordHash) {
      throw new UnauthorizedException(
        'Tài khoản này đăng nhập bằng Google. Vui lòng dùng nút "Đăng nhập với Google".',
      );
    }

    if (
      !user ||
      !user.passwordHash ||
      !(await bcrypt.compare(dto.password, user.passwordHash))
    )
      throw new UnauthorizedException('Invalid email or password');

    if (user.status === AccountStatus.PENDING_VERIFICATION) {
      throw new ForbiddenException(
        'Tài khoản chưa được kích hoạt. Vui lòng xác thực mã OTP gửi về email để hoàn tất đăng ký.',
      );
    }

    return this.userRepository.manager.transaction(async (manager) => {
      const current = await this.lockActiveUser(manager, user.id);
      const tokens = await this.issueTokens(current, manager, dto.deviceInfo);
      const permissions = await this.getPermissions(current.role);
      return { ...tokens, user: UserProfileDto.fromUser(current, permissions) };
    });
  }

  /**
   * Biến một hồ sơ Google đã xác thực thành phiên đăng nhập FixHome.
   *
   * Ba tình huống, xử lý khác nhau:
   *
   * Đã từng đăng nhập Google — tìm thấy theo `googleId`. Đây là đường thường
   * gặp nhất. Tra theo `googleId` chứ không theo email, vì người dùng đổi được
   * địa chỉ Gmail còn `sub` thì không đổi.
   *
   * Email đã có tài khoản mật khẩu — **tự động liên kết** theo quyết định của
   * PO. An toàn vì Google đã xác minh email đó là của họ, và
   * `GoogleIdentityService` đã chặn mọi hồ sơ có `email_verified` khác true.
   * Tài khoản giữ nguyên `authProvider` LOCAL vì mật khẩu cũ vẫn dùng được.
   *
   * Chưa có gì — tạo tài khoản CUSTOMER mới, không mật khẩu, trạng thái ACTIVE
   * luôn. Không bắt xác thực OTP nữa vì Google đã làm đúng việc đó rồi; bắt
   * thêm một lần nữa chỉ làm phiền người dùng mà không thêm bảo đảm nào.
   *
   * Vai trò luôn là CUSTOMER, đúng luật tự đăng ký hiện hành: tài khoản
   * TECHNICIAN do Service Manager hoặc Admin tạo.
   */
  private async resolveGoogleUser(profile: GoogleProfile): Promise<string> {
    const existing =
      (await this.userRepository.findOne({
        where: { googleId: profile.googleId },
      })) ??
      (await this.userRepository.findOne({ where: { email: profile.email } }));

    if (existing) {
      if (
        existing.status !== AccountStatus.ACTIVE ||
        !existing.isActive
      ) {
        // Dùng đúng câu của luồng đăng nhập thường, để một tài khoản bị khoá
        // không thể lách qua bằng cách đổi sang nút Google.
        throw new ForbiddenException('Account is locked or suspended');
      }

      return this.userRepository.manager.transaction(async (manager) => {
        const users = manager.getRepository(User);
        const user = await this.lockActiveUser(manager, existing.id);

        // Gắn google_id lần đầu tiên nếu tài khoản này vốn là tài khoản mật
        // khẩu. Nếu đã có google_id khác thì có gì đó rất sai — cùng một email
        // không thể thuộc hai tài khoản Google — nên dừng lại thay vì ghi đè.
        if (user.googleId && user.googleId !== profile.googleId) {
          throw new ConflictException(
            'Email này đã được liên kết với một tài khoản Google khác',
          );
        }
        if (!user.googleId) {
          user.googleId = profile.googleId;
        }
        // Google đã xác minh email, nên một tài khoản đăng ký bằng mật khẩu mà
        // chưa kịp nhập OTP coi như được xác minh từ đây.
        user.isEmailVerified = true;
        if (!user.avatarUrl && profile.avatarUrl) {
          user.avatarUrl = profile.avatarUrl;
        }
        await users.save(user);
        return user.id;
      });
    }

    return this.userRepository.manager.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const created = await users.save(
        users.create({
          email: profile.email,
          passwordHash: null,
          googleId: profile.googleId,
          authProvider: AuthProvider.GOOGLE,
          fullName: profile.fullName,
          avatarUrl: profile.avatarUrl,
          role: Role.CUSTOMER,
          status: AccountStatus.ACTIVE,
          isActive: true,
          isEmailVerified: true,
        }),
      );
      return created.id;
    });
  }

  /** Cấp phiên cho một tài khoản đã xác định, dùng chung cho mọi lối vào. */
  private async issueSessionForUser(
    userId: string,
    deviceInfo?: string,
  ): Promise<AuthResponseDto> {
    return this.userRepository.manager.transaction(async (manager) => {
      const user = await this.lockActiveUser(manager, userId);
      const tokens = await this.issueTokens(user, manager, deviceInfo);
      const permissions = await this.getPermissions(user.role);
      return { ...tokens, user: UserProfileDto.fromUser(user, permissions) };
    });
  }

  /** Lối vào của web: đã có ID token trong tay, trả luôn phiên. */
  async loginWithGoogle(
    profile: GoogleProfile,
    deviceInfo?: string,
  ): Promise<AuthResponseDto> {
    const userId = await this.resolveGoogleUser(profile);
    return this.issueSessionForUser(userId, deviceInfo);
  }

  /**
   * Lối vào của mobile, bước một.
   *
   * Không trả token thật ở đây, vì kết quả sẽ đi qua thanh địa chỉ của trình
   * duyệt để về lại app — mà URL thì bị ghi vào lịch sử duyệt web và log. Thay
   * vào đó trả một mã bàn giao sống 60 giây, dùng đúng một lần để đổi lấy
   * phiên thật qua POST. Kể cả có lộ, nó hết hạn trước khi ai kịp dùng.
   */
  async createGoogleHandoffCode(profile: GoogleProfile): Promise<string> {
    const userId = await this.resolveGoogleUser(profile);
    return this.jwtService.signAsync(
      { sub: userId, purpose: GOOGLE_HANDOFF_PURPOSE },
      {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: '60s',
        algorithm: 'HS256',
      },
    );
  }

  /** Lối vào của mobile, bước hai: đổi mã bàn giao lấy phiên thật. */
  async exchangeGoogleHandoffCode(
    code: string,
    deviceInfo?: string,
  ): Promise<AuthResponseDto> {
    let payload: { sub?: string; purpose?: string };
    try {
      payload = await this.jwtService.verifyAsync(code, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Mã đăng nhập đã hết hạn hoặc không hợp lệ');
    }
    // Cùng một khoá ký với access token, nên phải kiểm `purpose`; thiếu bước
    // này thì một access token thường cũng đổi được thành phiên mới.
    if (payload.purpose !== GOOGLE_HANDOFF_PURPOSE || !payload.sub) {
      throw new UnauthorizedException('Mã đăng nhập không hợp lệ');
    }
    return this.issueSessionForUser(payload.sub, deviceInfo);
  }

  async forgotPassword(dto: ForgotPasswordDto): Promise<{ message: string }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.userRepository.findOne({ where: { email } });

    if (!user || user.status !== AccountStatus.ACTIVE) {
      return {
        message:
          'Nếu email tồn tại trong hệ thống, mã OTP đặt lại mật khẩu đã được gửi đến hộp thư của bạn.',
      };
    }

    await this.generateAndSendOtp(
      email,
      OtpPurpose.RESET_PASSWORD,
      user.fullName,
    );

    return {
      message:
        'Nếu email tồn tại trong hệ thống, mã OTP đặt lại mật khẩu đã được gửi đến hộp thư của bạn.',
    };
  }

  async resetPassword(dto: ResetPasswordDto): Promise<{ message: string }> {
    const email = dto.email.toLowerCase().trim();
    const user = await this.userRepository.findOne({ where: { email } });
    if (!user) {
      throw new BadRequestException('Yêu cầu không hợp lệ');
    }

    const otpRecord = await this.otpRepository.findOne({
      where: { email, purpose: OtpPurpose.RESET_PASSWORD, isUsed: false },
      order: { createdAt: 'DESC' },
    });

    if (!otpRecord) {
      throw new BadRequestException('Mã OTP không hợp lệ hoặc đã được sử dụng');
    }

    const now = new Date();
    if (otpRecord.expiresAt < now) {
      throw new BadRequestException(
        'Mã OTP đã hết hạn. Vui lòng yêu cầu gửi lại mã.',
      );
    }

    if (otpRecord.attempts >= otpRecord.maxAttempts) {
      throw new BadRequestException(
        'Mã OTP đã bị khóa do nhập sai quá nhiều lần. Vui lòng yêu cầu gửi lại mã mới.',
      );
    }

    const inputHash = createHash('sha256')
      .update(dto.otp.trim())
      .digest('hex');
    if (inputHash !== otpRecord.codeHash) {
      otpRecord.attempts += 1;
      await this.otpRepository.save(otpRecord);
      const remaining = otpRecord.maxAttempts - otpRecord.attempts;
      if (remaining <= 0) {
        throw new BadRequestException(
          'Mã OTP đã bị khóa do nhập sai quá 5 lần. Vui lòng bấm gửi lại mã mới.',
        );
      }
      throw new BadRequestException(
        `Mã OTP không chính xác. Bạn còn ${remaining} lần thử.`,
      );
    }

    const passwordHash = await bcrypt.hash(dto.newPassword, 12);

    await this.userRepository.manager.transaction(async (manager) => {
      await manager
        .getRepository(OtpVerification)
        .update(otpRecord.id, { isUsed: true });

      user.passwordHash = passwordHash;
      // Người chỉ từng đăng nhập bằng Google vẫn được đặt mật khẩu qua đường
      // này, vì OTP gửi về chính email mà Google đã xác minh. Sau bước đó họ có
      // hai cách vào, nên `authProvider` chuyển về LOCAL đúng với nghĩa "tài
      // khoản này có mật khẩu"; `googleId` giữ nguyên nên nút Google vẫn chạy.
      user.authProvider = AuthProvider.LOCAL;
      await manager.getRepository(User).save(user);

      await manager
        .getRepository(RefreshToken)
        .update({ userId: user.id, isRevoked: false }, { isRevoked: true });
    });

    return {
      message:
        'Đặt lại mật khẩu thành công. Vui lòng đăng nhập với mật khẩu mới.',
    };
  }

  async refresh(dto: RefreshTokenDto): Promise<TokenRefreshResponseDto> {
    let payload: { sub: string; exp: number };
    try {
      payload = this.jwtService.verify(dto.refreshToken, {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        algorithms: ['HS256'],
      });
      if (typeof payload.sub !== 'string' || !Number.isFinite(payload.exp))
        throw new Error();
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
    const tokenHash = this.hashToken(dto.refreshToken);
    return this.userRepository.manager.transaction(async (manager) => {
      const user = await this.lockActiveUser(manager, payload.sub);
      const sessions = manager.getRepository(RefreshToken);
      const record = await sessions.findOne({
        where: { tokenHash, userId: user.id, isRevoked: false },
      });
      if (!record || record.expiresAt.getTime() <= Date.now())
        throw new UnauthorizedException('Refresh token is expired or revoked');
      const consumed = await sessions.update(
        { id: record.id, isRevoked: false },
        { isRevoked: true },
      );
      if (consumed.affected !== 1)
        throw new UnauthorizedException('Refresh token has already been used');
      return this.issueTokens(user, manager, record.deviceInfo);
    });
  }

  async logout(
    userId: string,
    refreshToken?: string,
  ): Promise<{ loggedOut: boolean }> {
    await this.userRepository.manager.transaction(async (manager) => {
      await manager
        .getRepository(User)
        .findOne({
          where: { id: userId },
          lock: { mode: 'pessimistic_write' },
        });
      await manager
        .getRepository(RefreshToken)
        .update(
          refreshToken
            ? { userId, tokenHash: this.hashToken(refreshToken) }
            : { userId, isRevoked: false },
          { isRevoked: true },
        );
    });
    return { loggedOut: true };
  }

  async getMe(userId: string): Promise<UserProfileDto> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User does not exist');
    const permissions = await this.getPermissions(user.role);
    return UserProfileDto.fromUser(user, permissions);
  }

  private async lockActiveUser(
    manager: EntityManager,
    id: string,
  ): Promise<User> {
    const user = await manager
      .getRepository(User)
      .findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
    if (!user) throw new UnauthorizedException('User does not exist');
    if (user.status !== AccountStatus.ACTIVE || !user.isActive)
      throw new ForbiddenException('Account is locked or suspended');
    return user;
  }

  private async issueTokens(
    user: User,
    manager: EntityManager,
    deviceInfo?: string,
  ): Promise<TokenRefreshResponseDto> {
    const accessToken = this.jwtService.sign(
      { sub: user.id, role: user.role },
      {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.configService.getOrThrow<string>(
          'JWT_ACCESS_EXPIRES_IN',
        ),
        algorithm: 'HS256',
      },
    );
    const refreshToken = this.jwtService.sign(
      { sub: user.id },
      {
        secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.configService.getOrThrow<string>(
          'JWT_REFRESH_EXPIRES_IN',
        ),
        algorithm: 'HS256',
        jwtid: randomUUID(),
      },
    );
    const { exp } = this.jwtService.decode(refreshToken) as { exp: number };
    const sessions = manager.getRepository(RefreshToken);
    await sessions.save(
      sessions.create({
        userId: user.id,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(exp * 1000),
        isRevoked: false,
        deviceInfo: deviceInfo || null,
      }),
    );
    return { accessToken, refreshToken };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
