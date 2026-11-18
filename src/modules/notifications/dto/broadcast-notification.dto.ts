import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export const BROADCAST_AUDIENCES = ['all', 'customer', 'technician', 'service_manager'] as const;
export type BroadcastAudience = (typeof BROADCAST_AUDIENCES)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class BroadcastNotificationDto {
  @ApiProperty({ description: 'Notification title', maxLength: 200 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({ description: 'Notification body', maxLength: 2000 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  message: string;

  @ApiPropertyOptional({ enum: BROADCAST_AUDIENCES, default: 'all' })
  @IsOptional()
  @IsIn(BROADCAST_AUDIENCES)
  audience?: BroadcastAudience;
}
