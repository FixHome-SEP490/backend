// src/modules/users/users.service.ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { User } from './entities/user.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { AccountStatus, Role } from '../../shared/enums';
import { normalizePhone } from '../../shared/validation/input.transforms';
import { PaginationMeta } from '../../shared/dto';
import { UpdateProfileDto, QueryUsersDto, UpdateUserStatusDto, CreateTechnicianDto } from './dto';
import { AuditLogService } from '../audit-log/audit-log.service';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly auditLogService: AuditLogService,
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
      user.fullName = dto.fullName.trim();
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

    const user = await this.userRepository.save(
      this.userRepository.create({
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

    await this.auditLogService.log({
      actorUserId: actor.id,
      actorRole: actor.role,
      action: 'TECHNICIAN_ACCOUNT_CREATED',
      resourceType: 'user',
      resourceId: user.id,
      after: { email, fullName: user.fullName },
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
