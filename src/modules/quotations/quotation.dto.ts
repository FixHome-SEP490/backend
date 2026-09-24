import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { CostItemType, PartSource, PartWarrantyOption, FulfillmentMethod } from '../../shared/enums';

export class CreateCostItemDto {
  @ApiProperty({ enum: CostItemType, example: CostItemType.LABOR, description: 'labor = tiền công; parts_equipment = linh kiện hoặc thiết bị.' })
  @IsEnum(CostItemType) type: CostItemType;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ApiProperty({ example: 'Kiểm tra và sửa máy', maxLength: 2000 })
  @IsString() @IsNotEmpty() @MaxLength(2000) description: string;
  @ApiProperty({ example: 1, minimum: 1, maximum: 1000 })
  @IsInt() @Min(1) @Max(1000) quantity: number;
  @ApiProperty({ example: 120000, minimum: 0, maximum: 999999999, description: 'Giá một đơn vị, VND; chỉ là số ví dụ trong Swagger.' })
  @IsInt() @Min(0) @Max(999999999) unitPrice: number;
  @ApiPropertyOptional({ minimum: 0, maximum: 3650, description: 'Thời hạn bảo hành ngày, nếu áp dụng.' })
  @IsOptional() @IsInt() @Min(0) @Max(3650) warrantyDays?: number;
  @ApiPropertyOptional({ enum: PartSource, description: 'Nguồn linh kiện khi type=parts_equipment; theo quy tắc hiện có của Backend.' })
  @IsOptional() @IsEnum(PartSource) partSource?: PartSource | null;
  @ApiPropertyOptional({ format: 'uuid', description: 'ID linh kiện trong catalog nếu chọn linh kiện FixHome.' })
  @IsOptional() @IsUUID() partCatalogId?: string | null;
  @ApiPropertyOptional({ maxLength: 255, description: 'Tên linh kiện tại thời điểm lập báo giá.' })
  @IsOptional() @IsString() @MaxLength(255) partNameSnapshot?: string | null;
  @ApiPropertyOptional({ enum: PartWarrantyOption, description: 'Lựa chọn bảo hành linh kiện nếu áp dụng.' })
  @IsOptional() @IsEnum(PartWarrantyOption) partWarrantyOption?: PartWarrantyOption | null;
  @ApiPropertyOptional({ minimum: 0, maximum: 999999999, description: 'Phí bảo hành linh kiện, VND, nếu có.' })
  @IsOptional() @IsInt() @Min(0) @Max(999999999) warrantyFee?: number | null;
  @ApiPropertyOptional({ minimum: 1, maximum: 3650, description: 'Số ngày bảo hành có phí, nếu có.' })
  @IsOptional() @IsInt() @Min(1) @Max(3650) warrantyTermDays?: number | null;
}
export class CreateQuotationDto {
  @ApiProperty({ type: () => CreateCostItemDto, isArray: true, minItems: 1, maxItems: 100, description: 'Các dòng tiền công/linh kiện. Khách duyệt báo giá qua endpoint decision riêng.' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CreateCostItemDto) items: CreateCostItemDto[];
  @ApiPropertyOptional({ maxLength: 5000, description: 'Ghi chú của thợ về báo giá.' })
  @IsOptional() @IsString() @MaxLength(5000) note?: string;
}
export class CreateAdditionalCostDto extends CreateQuotationDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @ApiProperty({ maxLength: 2000, description: 'Lý do cần chi phí phát sinh.' })
  @IsString() @IsNotEmpty() @MaxLength(2000) reason: string;
  @ApiPropertyOptional({ type: [String], maxItems: 10, description: 'Các tham chiếu bằng chứng kèm chi phí phát sinh, nếu có.' })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) evidenceUrls?: string[];
  @ApiPropertyOptional({ enum: FulfillmentMethod, default: FulfillmentMethod.PICKUP, description: 'Phương thức nhận linh kiện: PICKUP hoặc DELIVERY' })
  @IsOptional() @IsEnum(FulfillmentMethod) fulfillmentMethod?: FulfillmentMethod;
  @ApiPropertyOptional({ minimum: 0, maximum: 999999999, description: 'Phí vận chuyển nếu chọn DELIVERY' })
  @IsOptional() @IsInt() @Min(0) @Max(999999999) shippingFee?: number;
}
export class FinancialDecisionDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'], example: 'APPROVE', description: 'Khách duyệt hoặc từ chối báo giá/chi phí phát sinh.' })
  @IsIn(['APPROVE', 'REJECT']) action: 'APPROVE' | 'REJECT';
  @ApiPropertyOptional({ type: [String], maxItems: 100, uniqueItems: true, description: 'Các ID hạng mục bảo hành có phí mà khách chọn nếu áp dụng.' })
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(100) @IsUUID('all', { each: true }) paidWarrantyItemIds?: string[];
}
