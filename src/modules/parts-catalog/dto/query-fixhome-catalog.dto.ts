// src/modules/parts-catalog/dto/query-fixhome-catalog.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../shared/dto';

export class QueryFixHomeCatalogDto extends PaginationDto {
  @ApiPropertyOptional({
    description: 'Search active catalog by name, SKU, or description',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}
