// src/modules/audit-log/dto/query-audit-log.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from '../../../shared/dto';

export class QueryAuditLogDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Filter by resource type (e.g. "service", "system_config", "user")',
    example: 'system_config',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceType?: string;

  @ApiPropertyOptional({
    description: 'Filter by actor user ID',
    example: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
  })
  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @ApiPropertyOptional({
    description: 'Filter by action string (e.g. "CONFIG_UPDATE", "CREATE")',
    example: 'CONFIG_UPDATE',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  action?: string;
}
