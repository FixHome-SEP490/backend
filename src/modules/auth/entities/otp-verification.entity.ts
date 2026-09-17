// src/modules/auth/entities/otp-verification.entity.ts
import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../../database/base.entity';
import { OtpPurpose } from '../../../shared/enums';

@Entity('otp_verifications')
@Index('idx_otp_verifications_email_purpose', ['email', 'purpose'])
export class OtpVerification extends BaseEntity {
  @Column({ name: 'email', type: 'varchar', length: 255 })
  email: string;

  @Column({ name: 'code_hash', type: 'varchar', length: 255 })
  codeHash: string;

  @Column({ name: 'purpose', type: 'varchar', length: 50 })
  purpose: OtpPurpose;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'attempts', type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'max_attempts', type: 'int', default: 5 })
  maxAttempts: number;

  @Column({ name: 'is_used', type: 'boolean', default: false })
  isUsed: boolean;

  @Column({ name: 'resend_available_at', type: 'timestamptz' })
  resendAvailableAt: Date;
}
