import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { StockMovementKind } from '../entities';

export class AdjustStockDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  partId: string;

  @ApiProperty({ minimum: -2147483647, maximum: 2147483647 })
  @IsInt()
  @Min(-2147483647)
  @Max(2147483647)
  delta: number;

  @ApiProperty({ enum: StockMovementKind })
  @IsEnum(StockMovementKind)
  kind: StockMovementKind;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @IsString()
  @Length(1, 500)
  reason: string;

  @ApiProperty({ format: 'uuid', description: 'Client-generated idempotency command key' })
  @IsUUID()
  idempotencyKey: string;
}
