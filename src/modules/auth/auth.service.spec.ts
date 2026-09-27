// src/modules/auth/auth.service.spec.ts
import 'reflect-metadata';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { createHash } from 'crypto';
import { AuthService } from './auth.service';
import { User } from '../users/entities/user.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { Role, AccountStatus, OtpPurpose, AuthProvider } from '../../shared/enums';

describe('AuthService', () => {
  let authService: AuthService;
  let userRepository: any;
  let refreshTokenRepository: any;
  let otpRepository: any;
  let jwtService: any;
  let configService: any;
  let mailService: any;

  const mockUser: User = {
    id: 'user-uuid-1',
    email: 'customer@fixhome.vn',
    passwordHash: '',
    authProvider: AuthProvider.LOCAL,
    fullName: 'Nguyen Van A',
    phoneNumber: '0912345678',
    role: Role.CUSTOMER,
    status: AccountStatus.ACTIVE,
    isActive: true,
    isEmailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    refreshTokens: [],
  };

  beforeEach(async () => {
    mockUser.passwordHash = await bcrypt.hash('SecurePassword123!', 10);

    userRepository = {
      findOne: vi.fn(),
      create: vi.fn().mockImplementation((data) => ({ ...mockUser, ...data })),
      save: vi
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ ...mockUser, ...data }),
        ),
    };

    refreshTokenRepository = {
      findOne: vi.fn(),
      create: vi
        .fn()
        .mockImplementation((data) => ({ id: 'token-uuid', ...data })),
      save: vi
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ id: 'token-uuid', ...data }),
        ),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
    };

    otpRepository = {
      findOne: vi.fn(),
      create: vi
        .fn()
        .mockImplementation((data) => ({ id: 'otp-uuid', ...data })),
      save: vi
        .fn()
        .mockImplementation((data) =>
          Promise.resolve({ id: 'otp-uuid', ...data }),
        ),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
    };

    mailService = {
      sendRegisterOtp: vi.fn().mockResolvedValue(undefined),
      sendPasswordResetOtp: vi.fn().mockResolvedValue(undefined),
    };

    jwtService = {
      decode: vi
        .fn()
        .mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 604800 }),
      sign: vi.fn().mockReturnValue('mocked-jwt-token'),
      verify: vi
        .fn()
        .mockReturnValue({
          sub: mockUser.id,
          exp: Math.floor(Date.now() / 1000) + 604800,
        }),
    };

    configService = {
      get: vi.fn((key: string) => {
        if (key === 'JWT_ACCESS_SECRET') return 'test-access-secret';
        if (key === 'JWT_REFRESH_SECRET') return 'test-refresh-secret';
        if (key === 'JWT_ACCESS_EXPIRES_IN') return '15m';
        if (key === 'JWT_REFRESH_EXPIRES_IN') return '7d';
        return undefined;
      }),
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
      otpRepository,
      jwtService,
      configService,
      mailService,
    );
  });

  describe('register', () => {
    it('registers a new Customer successfully and triggers OTP email', async () => {
      userRepository.findOne.mockResolvedValue(null);
      otpRepository.findOne.mockResolvedValue(null);

      const result = await authService.register({
        email: 'customer@fixhome.vn',
        password: 'SecurePassword123!',
        fullName: 'Nguyen Van A',
        role: Role.CUSTOMER,
      });

      expect(result.email).toBe('customer@fixhome.vn');
      expect(result.expiresInMinutes).toBe(5);
      expect(result.message).toContain('thành công');
      expect(mailService.sendRegisterOtp).toHaveBeenCalledWith(
        'customer@fixhome.vn',
        expect.any(String),
        'Nguyen Van A',
      );
    });

    it('rejects public registration for TECHNICIAN role', async () => {
      await expect(
        authService.register({
          email: 'tech@fixhome.vn',
          password: 'SecurePassword123!',
          fullName: 'Tran Van Tech',
          role: Role.TECHNICIAN,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects registration with duplicate email when already active', async () => {
      userRepository.findOne.mockResolvedValueOnce({
        ...mockUser,
        status: AccountStatus.ACTIVE,
      });

      await expect(
        authService.register({
          email: 'customer@fixhome.vn',
          password: 'Password123!',
          fullName: 'Nguyen Van A',
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('verifyRegisterOtp', () => {
    it('activates account and returns JWT tokens on correct OTP', async () => {
      const pendingUser = {
        ...mockUser,
        status: AccountStatus.PENDING_VERIFICATION,
        isEmailVerified: false,
      };
      userRepository.findOne.mockResolvedValue(pendingUser);

      const otp = '123456';
      const codeHash = createHash('sha256').update(otp).digest('hex');
      otpRepository.findOne.mockResolvedValue({
        id: 'otp-uuid',
        email: mockUser.email,
        codeHash,
        purpose: OtpPurpose.REGISTER,
        expiresAt: new Date(Date.now() + 300000),
        attempts: 0,
        maxAttempts: 5,
        isUsed: false,
      });

      const result = await authService.verifyRegisterOtp({
        email: mockUser.email,
        otp,
      });

      expect(result.accessToken).toBe('mocked-jwt-token');
      expect(result.refreshToken).toBe('mocked-jwt-token');
      expect(result.user.status).toBe(AccountStatus.ACTIVE);
      expect(result.user.isEmailVerified).toBe(true);
    });

    it('throws BadRequestException on incorrect OTP', async () => {
      const pendingUser = {
        ...mockUser,
        status: AccountStatus.PENDING_VERIFICATION,
        isEmailVerified: false,
      };
      userRepository.findOne.mockResolvedValue(pendingUser);

      const codeHash = createHash('sha256').update('123456').digest('hex');
      otpRepository.findOne.mockResolvedValue({
        id: 'otp-uuid',
        email: mockUser.email,
        codeHash,
        purpose: OtpPurpose.REGISTER,
        expiresAt: new Date(Date.now() + 300000),
        attempts: 0,
        maxAttempts: 5,
        isUsed: false,
      });

      await expect(
        authService.verifyRegisterOtp({
          email: mockUser.email,
          otp: '999999',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('login', () => {
    it('logs in user successfully with correct credentials', async () => {
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await authService.login({
        email: 'customer@fixhome.vn',
        password: 'SecurePassword123!',
      });

      expect(result.accessToken).toBe('mocked-jwt-token');
      expect(result.refreshToken).toBe('mocked-jwt-token');
      expect(result.user.email).toBe('customer@fixhome.vn');
    });

    it('throws ForbiddenException when account is PENDING_VERIFICATION', async () => {
      const pendingUser = {
        ...mockUser,
        status: AccountStatus.PENDING_VERIFICATION,
      };
      userRepository.findOne.mockResolvedValue(pendingUser);

      await expect(
        authService.login({
          email: 'customer@fixhome.vn',
          password: 'SecurePassword123!',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws ForbiddenException when account is LOCKED', async () => {
      const lockedUser = { ...mockUser, status: AccountStatus.LOCKED };
      userRepository.findOne.mockResolvedValue(lockedUser);

      await expect(
        authService.login({
          email: 'customer@fixhome.vn',
          password: 'SecurePassword123!',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('forgotPassword & resetPassword', () => {
    it('sends password reset OTP when email exists and is active', async () => {
      userRepository.findOne.mockResolvedValue(mockUser);
      otpRepository.findOne.mockResolvedValue(null);

      const result = await authService.forgotPassword({
        email: mockUser.email,
      });

      expect(result.message).toContain('Nếu email tồn tại');
      expect(mailService.sendPasswordResetOtp).toHaveBeenCalledWith(
        mockUser.email,
        expect.any(String),
        mockUser.fullName,
      );
    });

    it('resets password successfully when OTP is valid', async () => {
      userRepository.findOne.mockResolvedValue({ ...mockUser });

      const otp = '654321';
      const codeHash = createHash('sha256').update(otp).digest('hex');
      otpRepository.findOne.mockResolvedValue({
        id: 'otp-uuid-reset',
        email: mockUser.email,
        codeHash,
        purpose: OtpPurpose.RESET_PASSWORD,
        expiresAt: new Date(Date.now() + 300000),
        attempts: 0,
        maxAttempts: 5,
        isUsed: false,
      });

      const result = await authService.resetPassword({
        email: mockUser.email,
        otp,
        newPassword: 'NewSecurePassword456!',
      });

      expect(result.message).toContain('thành công');
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { userId: mockUser.id, isRevoked: false },
        { isRevoked: true },
      );
    });
  });

  describe('refresh token rotation', () => {
    it('rotates refresh token and returns new tokens', async () => {
      const tokenRecord: RefreshToken = {
        id: 'token-uuid',
        userId: mockUser.id,
        user: mockUser,
        tokenHash: 'hashed_token',
        expiresAt: new Date(Date.now() + 1000000),
        isRevoked: false,
        deviceInfo: 'test',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      refreshTokenRepository.findOne.mockResolvedValue(tokenRecord);
      userRepository.findOne.mockResolvedValue(mockUser);

      const result = await authService.refresh({
        refreshToken: 'valid-refresh-token',
      });

      expect(result.accessToken).toBe('mocked-jwt-token');
      expect(result.refreshToken).toBe('mocked-jwt-token');
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { id: 'token-uuid', isRevoked: false },
        { isRevoked: true },
      );
    });
  });

  describe('logout', () => {
    it('invalidates refresh tokens on logout', async () => {
      const result = await authService.logout(mockUser.id);
      expect(result.loggedOut).toBe(true);
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { userId: mockUser.id, isRevoked: false },
        { isRevoked: true },
      );
    });
  });

  describe('getMe', () => {
    it('returns current user profile', async () => {
      userRepository.findOne.mockResolvedValue(mockUser);

      const profile = await authService.getMe(mockUser.id);
      expect(profile.id).toBe(mockUser.id);
      expect(profile.email).toBe(mockUser.email);
    });
  });
});
