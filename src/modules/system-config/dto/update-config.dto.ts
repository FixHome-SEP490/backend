// src/modules/system-config/dto/update-config.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class UpdateConfigDto {
  /**
   * Raw string value. Per-key validation is applied in AdminConfigService
   * based on the key's valueType and allowed range.
   * No arbitrary JSON mutation is accepted here — parsing is done server-side.
   */
  @ApiProperty({
    description: 'New value for the config key (validated server-side per key type)',
    example: '500',
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(512)
  value: string;
}
