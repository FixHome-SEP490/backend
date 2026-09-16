import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { CostItemType, PartSource, PartWarrantyOption } from '../../shared/enums';

export class CreateCostItemDto {
  @IsEnum(CostItemType) type: CostItemType;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @IsNotEmpty() @MaxLength(2000) description: string;
  @IsInt() @Min(1) @Max(1000) quantity: number;
  @IsInt() @Min(0) @Max(999999999) unitPrice: number;
  @IsOptional() @IsInt() @Min(0) @Max(3650) warrantyDays?: number;
  @IsOptional() @IsEnum(PartSource) partSource?: PartSource | null;
  @IsOptional() @IsUUID() partCatalogId?: string | null;
  @IsOptional() @IsString() @MaxLength(255) partNameSnapshot?: string | null;
  @IsOptional() @IsEnum(PartWarrantyOption) partWarrantyOption?: PartWarrantyOption | null;
  @IsOptional() @IsInt() @Min(0) @Max(999999999) warrantyFee?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(3650) warrantyTermDays?: number | null;
}
export class CreateQuotationDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => CreateCostItemDto) items: CreateCostItemDto[];
  @IsOptional() @IsString() @MaxLength(5000) note?: string;
}
export class CreateAdditionalCostDto extends CreateQuotationDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @IsNotEmpty() @MaxLength(2000) reason: string;
}
export class FinancialDecisionDto {
  @IsIn(['APPROVE', 'REJECT']) action: 'APPROVE' | 'REJECT';
  @IsOptional() @IsArray() @ArrayUnique() @ArrayMaxSize(100) @IsUUID('all', { each: true }) paidWarrantyItemIds?: string[];
}
