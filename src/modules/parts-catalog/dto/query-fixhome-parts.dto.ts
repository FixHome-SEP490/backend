// src/modules/parts-catalog/dto/query-fixhome-parts.dto.ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';
import { QueryFixHomeCatalogDto } from './query-fixhome-catalog.dto';

export class QueryFixHomePartsDto extends QueryFixHomeCatalogDto {
  @ApiPropertyOptional({
    description: 'Admin filter by active status',
    type: Boolean,
  })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  isActive?: boolean;
}
