import { ApiProperty } from '@nestjs/swagger';

export class FixHomePartResponseDto {
  @ApiProperty({ format: 'uuid', example: '0f6f5be2-0bdb-4b91-9a86-327e287c1c31' })
  id: string;

  @ApiProperty({ type: String, nullable: true, example: 'FH-BEARING-6204' })
  sku: string | null;

  @ApiProperty({ example: 'Vòng bi 6204 chính hãng', maxLength: 200 })
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Vòng bi dùng cho máy giặt cửa trước',
  })
  description: string | null;

  @ApiProperty({
    type: Number,
    example: 185000,
    minimum: 0,
    maximum: 9999999999.99,
    description: 'FixHome catalog selling price in VND',
  })
  sellingPrice: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 180,
    minimum: 0,
    maximum: 3650,
    description: 'Warranty duration in days when configured',
  })
  warrantyDays: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Bảo hành 6 tháng theo chính sách FixHome',
  })
  warrantyPolicy: string | null;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}
