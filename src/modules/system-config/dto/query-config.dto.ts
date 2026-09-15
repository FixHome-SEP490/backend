// src/modules/system-config/dto/query-config.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class QueryConfigDto {
  @ApiPropertyOptional({ description: 'Filter by partial key match' })
  @IsOptional()
  @IsString()
  search?: string;
}
