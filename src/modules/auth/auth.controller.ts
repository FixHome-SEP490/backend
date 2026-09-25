// src/modules/auth/auth.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
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
  GoogleIdTokenDto,
  GoogleHandoffDto,
  GoogleAuthorizeQueryDto,
} from './dto';
import { GoogleIdentityService } from './google-identity.service';
import { GoogleRedirectService } from './google-redirect.service';
import { JwtAuthGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import { RolesGuard } from '../../common/guards';
import { LogoutDto } from './dto/logout.dto';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly googleIdentity: GoogleIdentityService,
    private readonly googleRedirect: GoogleRedirectService,
  ) {}

  @Post('register')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Register a new Customer account and send verification OTP via email',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Account registered. OTP sent to email.',
    type: RegisterResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Validation failed or disallowed role',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Email or phone number already registered',
  })
  async register(@Body() dto: RegisterDto): Promise<RegisterResponseDto> {
    return this.authService.register(dto);
  }

  @Post('verify-register-otp')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify registration OTP and activate account, returning JWT tokens',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Account activated successfully',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid, expired, or locked OTP',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Account not found',
  })
  async verifyRegisterOtp(
    @Body() dto: VerifyOtpDto,
  ): Promise<AuthResponseDto> {
    return this.authService.verifyRegisterOtp(dto);
  }

  @Post('resend-register-otp')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resend registration OTP to email' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'New OTP sent to email successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Rate limit cooldown or account already active',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Account not found',
  })
  async resendRegisterOtp(@Body() dto: ResendOtpDto) {
    return this.authService.resendRegisterOtp(dto);
  }

  @Post('forgot-password')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset OTP to email' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Reset password OTP sent if email exists',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Cooldown active',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto);
  }

  @Post('reset-password')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using OTP and set new password' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Password reset successfully',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Invalid or expired OTP',
  })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto);
  }

  @Post('login')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email/phone and password' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Login successful',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid credentials',
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'Account is locked, suspended, or pending verification',
  })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  // ─────────────────────────────── Đăng nhập Google ───────────────────────────
  //
  // Hai lối vào cho hai loại client, cùng đổ về một chỗ xử lý tài khoản.
  //
  // Web: Google Identity Services chạy ngay trong trình duyệt và đưa sẵn ID
  // token, nên chỉ cần một lần POST.
  //
  // Mobile: Expo Go không dùng được đường trên, vì Google không chấp nhận địa
  // chỉ quay về kiểu `exp://192.168.1.8:8081`. App mở trình duyệt trỏ vào
  // `/google/start`, backend đưa qua Google rồi nhận lại ở `/google/callback`,
  // cuối cùng trả app một mã bàn giao để đổi lấy phiên qua `/google/exchange`.

  @Post('google')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Đăng nhập bằng ID token của Google (dùng cho web)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Đăng nhập thành công',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'ID token không hợp lệ hoặc email chưa được Google xác minh',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Máy chủ chưa cấu hình GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET',
  })
  async loginWithGoogle(
    @Body() dto: GoogleIdTokenDto,
  ): Promise<AuthResponseDto> {
    const profile = await this.googleIdentity.verifyIdToken(dto.idToken);
    return this.authService.loginWithGoogle(profile, dto.deviceInfo);
  }

  // Hai handler dưới đây tự cầm `Response` thay vì dùng `@Redirect()`.
  //
  // Lý do: `TransformInterceptor` bọc mọi giá trị trả về vào phong bì
  // `{ success, data }`, nên Nest không còn nhìn thấy khoá `url` ở cấp ngoài và
  // chuyển hướng tới một địa chỉ rỗng. Đo thật trên máy: phản hồi là HTTP 200
  // với nội dung "OK. Redirecting to " bỏ lửng. Cầm `Response` trực tiếp thì đi
  // thẳng, không qua interceptor.

  @Get('google/start')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Mở trang đồng ý của Google (dùng cho mobile)',
  })
  @ApiResponse({
    status: HttpStatus.FOUND,
    description: 'Chuyển hướng sang trang đăng nhập của Google',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Địa chỉ quay về không nằm trong danh sách được phép',
  })
  async startGoogleAuthorization(
    @Query() query: GoogleAuthorizeQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    const appRedirect = this.googleRedirect.validateAppRedirect(query.redirect);
    const state = await this.googleRedirect.signState(appRedirect);
    res.redirect(this.googleIdentity.buildAuthorizationUrl(state));
  }

  @Get('google/callback')
  @ApiOperation({
    summary: 'Nhận kết quả từ Google rồi đưa người dùng về lại ứng dụng',
  })
  @ApiResponse({
    status: HttpStatus.FOUND,
    description:
      'Chuyển hướng về ứng dụng kèm mã bàn giao, hoặc kèm mã lỗi nếu thất bại',
  })
  async handleGoogleCallback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<void> {
    // Đọc state trước mọi thứ khác: chưa biết được phép quay về đâu thì không
    // có chỗ nào an toàn để báo lỗi, kể cả khi Google đã báo lỗi sẵn.
    const appRedirect = await this.googleRedirect.readState(state);

    // Người dùng bấm huỷ ở màn hình Google cũng rơi vào đây. Đưa họ về app kèm
    // lý do, thay vì bỏ mặc ở một trang trắng của backend.
    if (error || !code) {
      res.redirect(
        this.googleRedirect.buildAppCallbackUrl(appRedirect, {
          error: error || 'missing_code',
        }),
      );
      return;
    }

    try {
      const profile = await this.googleIdentity.exchangeCode(code);
      const handoffCode =
        await this.authService.createGoogleHandoffCode(profile);
      res.redirect(
        this.googleRedirect.buildAppCallbackUrl(appRedirect, {
          code: handoffCode,
        }),
      );
    } catch (caught) {
      // Cũng vậy: lỗi nghiệp vụ như tài khoản bị khoá phải hiện trong app, nơi
      // người dùng đang nhìn, chứ không phải trong tab trình duyệt sắp đóng.
      const reason =
        caught instanceof Error && caught.message
          ? caught.message
          : 'google_sign_in_failed';
      res.redirect(
        this.googleRedirect.buildAppCallbackUrl(appRedirect, {
          error: reason,
        }),
      );
    }
  }

  @Post('google/exchange')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Đổi mã bàn giao lấy phiên đăng nhập thật (dùng cho mobile)',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Đăng nhập thành công',
    type: AuthResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Mã bàn giao đã hết hạn hoặc không hợp lệ',
  })
  async exchangeGoogleHandoff(
    @Body() dto: GoogleHandoffDto,
  ): Promise<AuthResponseDto> {
    return this.authService.exchangeGoogleHandoffCode(dto.code, dto.deviceInfo);
  }

  @Post('refresh')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate and refresh JWT access token using refresh token',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Token refreshed successfully',
    type: TokenRefreshResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Invalid, revoked or expired refresh token',
  })
  async refresh(
    @Body() dto: RefreshTokenDto,
  ): Promise<TokenRefreshResponseDto> {
    return this.authService.refresh(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Logout and revoke active session/tokens' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Logged out successfully',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthenticated',
  })
  async logout(@CurrentUser('id') userId: string, @Body() dto: LogoutDto) {
    return this.authService.logout(userId, dto?.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get profile of current authenticated user' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Current user profile fetched successfully',
    type: UserProfileDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'Unauthenticated',
  })
  async getMe(@CurrentUser('id') userId: string): Promise<UserProfileDto> {
    return this.authService.getMe(userId);
  }
}
