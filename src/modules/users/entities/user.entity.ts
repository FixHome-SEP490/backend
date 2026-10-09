// src/modules/users/entities/user.entity.ts
import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { Role, AccountStatus, AuthProvider } from '../../../shared/enums';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';

@Entity('users')
@Index('idx_users_email', ['email'], { unique: true })
@Index('idx_users_phone_number', ['phoneNumber'], {
  unique: true,
  where: '"phone_number" IS NOT NULL',
})
@Index('idx_users_role', ['role'])
@Index('idx_users_status', ['status'])
@Index('ux_users_google_id', ['googleId'], {
  unique: true,
  where: '"google_id" IS NOT NULL',
})
export class User extends BaseEntity {
  @Column({ name: 'email', type: 'varchar' })
  email: string;

  /**
   * NULL với tài khoản chỉ đăng nhập bằng Google — họ không có mật khẩu nào cả.
   * Mọi chỗ so khớp mật khẩu phải kiểm NULL trước khi gọi bcrypt.
   */
  @Column({ name: 'password_hash', type: 'varchar', nullable: true, select: false })
  passwordHash: string | null;

  @Column({ name: 'full_name', type: 'varchar' })
  fullName: string;

  @Column({ name: 'phone_number', type: 'varchar', nullable: true })
  phoneNumber: string;

  @Column({ type: 'enum', enum: Role, default: Role.CUSTOMER })
  role: Role;

  @Column({
    name: 'status',
    type: 'enum',
    enum: AccountStatus,
    default: AccountStatus.ACTIVE,
  })
  status: AccountStatus;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'is_email_verified', type: 'boolean', default: false })
  isEmailVerified: boolean;

  @Column({ name: 'avatar_url', type: 'varchar', nullable: true })
  avatarUrl?: string | null;

  /**
   * Trường `sub` của Google: định danh ổn định, không đổi kể cả khi người dùng
   * đổi địa chỉ Gmail. Không dùng email làm khoá liên kết vì email đổi được.
   */
  @Column({ name: 'google_id', type: 'varchar', nullable: true })
  googleId?: string | null;

  @Column({
    name: 'auth_provider',
    type: 'varchar',
    length: 20,
    default: AuthProvider.LOCAL,
  })
  authProvider: AuthProvider;

  @Column({
    name: 'booking_suspended_until',
    type: 'timestamptz',
    nullable: true,
  })
  bookingSuspendedUntil?: Date | null;

  /** Reputation points 0-100 (PO 08/10/2026), see modules/reputation/reputation-rules.ts. */
  @Column({ name: 'reputation_points', type: 'int', default: 100 })
  reputationPoints: number;

  /** Start of the current reputation period; the score goes back to 100 when it ends. */
  @Column({ name: 'reputation_period_start', type: 'timestamptz', default: () => 'now()' })
  reputationPeriodStart: Date;

  @Column({ name: 'date_of_birth', type: 'date', nullable: true })
  dateOfBirth?: Date | null;

  @Column({ name: 'gender', type: 'varchar', length: 10, nullable: true })
  gender?: string | null;

  /**
   * Số CCCD 12 chữ số. Lưu dạng plain text vì đồ án không yêu cầu mã hóa
   * cấp DB (Overview §33 — giữ phù hợp đồ án). Trong production sẽ mã hóa
   * AES-256.
   */
  @Column({ name: 'citizen_id_number', type: 'varchar', length: 20, nullable: true })
  citizenIdNumber?: string | null;

  @OneToMany(() => RefreshToken, (token) => token.user)
  refreshTokens: RefreshToken[];
}
