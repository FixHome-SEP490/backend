// src/modules/users/users.service.ts
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { User } from './entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { AccountStatus, Role, VerificationStatus } from '../../shared/enums';
import { normalizePhone } from '../../shared/validation/input.transforms';
import { PaginationMeta } from '../../shared/dto';
import { UpdateProfileDto, QueryUsersDto, UpdateUserStatusDto, CreateTechnicianDto } from './dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { CustomerVerification } from '../customer-verifications/entities/customer-verification.entity';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly auditLogService: AuditLogService,
    @InjectRepository(CustomerVerification)
    private readonly customerVerificationRepo: Repository<CustomerVerification>,
  ) {}

  async getProfile(userId: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User profile not found');
    }

    return user;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<User> {
    const user = await this.getProfile(userId);

    // If updating phone number, verify uniqueness
    if (dto.phoneNumber && dto.phoneNumber !== user.phoneNumber) {
      const existing = await this.userRepository.findOne({
        where: { phoneNumber: normalizePhone(dto.phoneNumber) },
      });
      if (existing && existing.id !== userId) {
        throw new ConflictException(
          'Phone number is already registered by another account',
        );
      }
      user.phoneNumber = normalizePhone(dto.phoneNumber);
    }

    if (dto.fullName) {
      const fullName = dto.fullName.trim();
      if (fullName !== user.fullName) {
        await this.assertIdentityEditable(user);
      }
      user.fullName = fullName;
    }

    if (dto.avatarUrl !== undefined) {
      user.avatarUrl = dto.avatarUrl;
    }

    await this.userRepository.update(userId, {
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      avatarUrl: user.avatarUrl,
    });
    return this.getProfile(userId);
  }

  /**
   * PO 14/10/2026: once a customer's identity is verified, the full name and
   * date of birth on the profile are the ones checked against the ID card and
   * can no longer be changed (re-sending the same value is fine).
   */
  private async assertIdentityEditable(user: User): Promise<void> {
    if (user.role !== Role.CUSTOMER) return;
    const verified = await this.customerVerificationRepo.exists({
      where: { customerId: user.id, status: VerificationStatus.VERIFIED },
    });
    if (verified) {
      throw new BusinessException(
        ErrorCodes.VALIDATION_FAILED,
        'Họ tên và ngày sinh đã được xác minh theo CCCD nên không thể thay đổi. Vui lòng liên hệ FixHome nếu thông tin bị sai.',
      );
    }
  }

  async findUsers(
    query: QueryUsersDto,
  ): Promise<{ data: User[]; meta: PaginationMeta }> {
    const queryBuilder = this.userRepository.createQueryBuilder('user');

    if (query.role) {
      queryBuilder.andWhere('user.role = :role', { role: query.role });
    }

    if (query.status) {
      queryBuilder.andWhere('user.status = :status', { status: query.status });
    }

    if (query.search) {
      const searchTerm = `%${query.search.trim()}%`;
      queryBuilder.andWhere(
        '(user.email ILIKE :search OR user.fullName ILIKE :search OR user.phoneNumber ILIKE :search)',
        { search: searchTerm },
      );
    }

    queryBuilder.orderBy('user.createdAt', 'DESC');
    queryBuilder.skip(query.skip).take(query.limit);

    const [data, total] = await queryBuilder.getManyAndCount();

    const meta: PaginationMeta = {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };

    return { data, meta };
  }

  async getUserById(id: string): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    return user;
  }

  /**
   * SM/Admin onboards a Technician account. Public self-register only allows
   * CUSTOMER (see AuthService.register); Technician accounts must be created
   * by staff. Returns a one-time temp password — it is never stored in
   * plaintext or retrievable again, so it must be relayed to the technician
   * out-of-band right after this call.
   */
  async createTechnician(
    dto: CreateTechnicianDto,
    actor: { id: string; role: string },
  ): Promise<{ user: User; tempPassword: string }> {
    const email = dto.email.toLowerCase().trim();
    const phoneNumber = dto.phoneNumber ? normalizePhone(dto.phoneNumber) : null;

    if (await this.userRepository.findOne({ where: { email } })) {
      throw new ConflictException('Email is already registered');
    }
    if (phoneNumber && (await this.userRepository.findOne({ where: { phoneNumber } }))) {
      throw new ConflictException('Phone number is already registered');
    }

    const tempPassword = randomBytes(9).toString('base64url');
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const user = await this.userRepository.manager.transaction(async (manager) => {
      const users = manager.getRepository(User);
      let created: User;
      try {
        created = await users.save(
          users.create({
            email,
            phoneNumber,
            passwordHash,
            fullName: dto.fullName.trim(),
            role: Role.TECHNICIAN,
            status: AccountStatus.ACTIVE,
            isActive: true,
            isEmailVerified: true,
          }),
        );
      } catch (error) {
        // The database unique indexes remain authoritative when pre-checks race.
        if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
          throw new ConflictException('Email or phone number is already registered');
        }
        throw error;
      }

      const profiles = manager.getRepository(TechnicianProfile);
      await profiles.save(profiles.create({
        userId: created.id,
        verificationStatus: VerificationStatus.PENDING,
        isAvailable: false, // same initialization as technician self-registration
      }));

      await this.auditLogService.logWithManagerStrict(manager, {
        actorUserId: actor.id,
        actorRole: actor.role,
        action: 'TECHNICIAN_ACCOUNT_CREATED',
        resourceType: 'user',
        resourceId: created.id,
        after: { email, fullName: created.fullName },
      });
      return created;
    });

    return { user, tempPassword };
  }

  async updateUserStatus(
    id: string,
    dto: UpdateUserStatusDto,
    actor?: { id: string; role: string },
  ): Promise<User> {
    return this.userRepository.manager.transaction(async (manager) => {
      const users = manager.getRepository(User);
      const user = await users.findOne({
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('User not found');
      if (dto.status !== AccountStatus.ACTIVE) {
        if (actor?.id === id) {
          throw new BadRequestException('Không thể tự khoá tài khoản của chính mình.');
        }
        // Keep at least one active admin, or nobody can unlock anyone.
        if (user.role === Role.ADMIN && user.isActive) {
          const otherActiveAdmins = await users
            .createQueryBuilder('u')
            .where('u.role = :role', { role: Role.ADMIN })
            .andWhere('u.is_active = true')
            .andWhere('u.id <> :id', { id })
            .getCount();
          if (otherActiveAdmins === 0) {
            throw new BadRequestException('Không thể khoá quản trị viên cuối cùng còn hoạt động.');
          }
        }
      }
      const previousStatus = user.status;
      user.status = dto.status;
      user.isActive = dto.status === AccountStatus.ACTIVE;
      await users.save(user);
      if (!user.isActive)
        await manager
          .getRepository(RefreshToken)
          .update({ userId: id, isRevoked: false }, { isRevoked: true });

      await this.auditLogService.logWithManager(manager, {
        actorUserId: actor?.id ?? null,
        actorRole: actor?.role ?? null,
        action: 'USER_STATUS_CHANGE',
        resourceType: 'user',
        resourceId: id,
        before: { status: previousStatus },
        after: { status: dto.status },
      });

      return user;
    });
  }
}
