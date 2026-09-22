// src/modules/technician-skill-verifications/dto/query-skill-verifications.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationDto } from '../../../shared/dto';
import { VerificationStatus } from '../../../shared/enums';

export class QuerySkillVerificationsDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: VerificationStatus,
    description: 'Filter by verification status (PENDING, VERIFIED, REJECTED)',
  })
  @IsOptional()
  @IsEnum(VerificationStatus)
  status?: VerificationStatus;
}
