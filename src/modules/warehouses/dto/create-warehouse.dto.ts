import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class CreateWarehouseDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  address?: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  responsibleUserId: string;
}
