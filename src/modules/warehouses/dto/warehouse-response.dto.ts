import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WarehouseStatus } from '../entities';

export class WarehouseResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional({ nullable: true })
  address: string | null;

  @ApiPropertyOptional({ nullable: true })
  latitude: number | null;

  @ApiPropertyOptional({ nullable: true })
  longitude: number | null;

  @ApiProperty({ enum: WarehouseStatus })
  status: WarehouseStatus;

  @ApiProperty({ format: 'uuid' })
  responsibleUserId: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt: Date;
}

export class StockMovementResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId: string;

  @ApiProperty({ format: 'uuid' })
  partId: string;

  @ApiProperty({ format: 'uuid' })
  actorUserId: string;

  @ApiProperty()
  kind: string;

  @ApiProperty()
  delta: number;

  @ApiProperty()
  reason: string;

  @ApiProperty({ format: 'uuid' })
  idempotencyKey: string;

  @ApiProperty()
  onHandAfter: number;

  @ApiProperty()
  reservedAfter: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;

  /** Set for part request movements (reserve, release, issue, return); null for manual stock changes. */
  @ApiProperty({ format: 'uuid', nullable: true, required: false })
  partRequestId?: string | null;
}
