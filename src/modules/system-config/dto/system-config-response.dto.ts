import { ApiProperty } from '@nestjs/swagger';
import { ConfigEffectStatus } from '../admin-config.service';
import { SystemConfig } from '../entities/system-config.entity';

const CONFIG_EFFECT_STATUSES: ConfigEffectStatus[] = [
  'ACTIVE',
  'TO_WIRE',
  'NOT_IMPLEMENTED',
  'STALE_REVIEW',
];

export class SystemConfigResponseDto {
  @ApiProperty({ example: 'commission.rate_bps' })
  key: string;

  @ApiProperty({ example: '1000' })
  value: string;

  @ApiProperty({
    enum: ['int', 'bigint', 'string', 'enum', 'boolean'],
    example: 'int',
  })
  valueType: SystemConfig['valueType'];

  @ApiProperty({ type: String, nullable: true, example: 'Commission in basis points' })
  description: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  updatedByUserId: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;

  @ApiProperty({ enum: CONFIG_EFFECT_STATUSES, example: 'ACTIVE' })
  effectStatus: ConfigEffectStatus;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Exact runtime consumer evidence when the key is not fully wired.',
  })
  consumerEvidence: string | null;
}
