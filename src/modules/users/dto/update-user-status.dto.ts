// src/modules/users/dto/update-user-status.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AccountStatus } from '../../../shared/enums';

export class UpdateUserStatusDto {
  // PENDING_VERIFICATION is the state before the email OTP, reached only by
  // registering; an admin setting it would let the owner "re-register" over it.
  @ApiProperty({
    enum: [AccountStatus.ACTIVE, AccountStatus.LOCKED, AccountStatus.SUSPENDED],
    example: AccountStatus.LOCKED,
    description: 'New account status',
  })
  @IsIn([AccountStatus.ACTIVE, AccountStatus.LOCKED, AccountStatus.SUSPENDED], {
    message: 'status must be one of active, locked, suspended',
  })
  @IsNotEmpty({ message: 'status is required' })
  status: AccountStatus;

  @ApiPropertyOptional({
    example: 'Suspicious spam activity reported',
    description: 'Reason for status change',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
