import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';
import { EvidenceType } from '../../shared/enums';

export class CheckInDto {
  @ApiProperty({ example: 10.7769, minimum: -90, maximum: 90, description: 'Technician GPS latitude; compared with the saved repair address.' })
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @ApiProperty({ example: 106.7009, minimum: -180, maximum: 180, description: 'Technician GPS longitude.' })
  @IsNumber() @Min(-180) @Max(180) lng: number;
  @ApiProperty({ example: 15, minimum: 0, maximum: 100000, description: 'Device-reported GPS accuracy (meters). Inspect result; this input does not guarantee a valid arrival.' })
  @IsNumber() @Min(0) @Max(100000) accuracyMeters: number;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true, description: 'Optional non-secret device metadata.' })
  @IsOptional() @IsObject() deviceInfo?: Record<string, unknown>;
}
export class UpdateLocationDto {
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @IsNumber() @Min(-180) @Max(180) lng: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000) accuracyMeters?: number;
}
export class EvidenceDto {
  @ApiProperty({ enum: EvidenceType, example: EvidenceType.BEFORE, description: 'before / after / additional; send as multipart field together with image file.' })
  @IsEnum(EvidenceType) type: EvidenceType;
  @ApiPropertyOptional({ maxLength: 2000, description: 'Optional note about this photo evidence.' })
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @ApiPropertyOptional({ format: 'date-time', description: 'Optional ISO 8601 capture timestamp, not in the future.' })
  @IsOptional() @IsDateString() capturedAt?: string;
}
export class CompletionRequestDto {
  @ApiPropertyOptional({ maxLength: 2000, example: 'Đã hoàn tất công việc', description: 'Optional technician note. AFTER evidence and required approvals must exist; this does not mark the order paid.' })
  @IsOptional() @IsString() @MaxLength(2000) completionNote?: string;
}
export class CompletionConfirmationDto {
  @ApiPropertyOptional({ maxLength: 2000, example: 'Đã kiểm tra kết quả sửa chữa', description: 'Optional customer feedback about completed work.' })
  @IsOptional() @IsString() @MaxLength(2000) feedback?: string;
  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: 5, description: 'Optional service rating; not proof of payment.' })
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @ApiPropertyOptional({ format: 'uri', description: 'Optional HTTPS signature URL; no tokens or credentials.' })
  @IsOptional() @IsUrl({ protocols: ['https'], require_protocol: true }) signatureUrl?: string;
}
export class ReasonDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @IsNotEmpty() @MaxLength(2000) reason: string;
}
export class CashDeclarationDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999999999999) declaredAmount: number;
  @IsOptional() @IsString() @MaxLength(2000) technicianNotes?: string;
  @IsOptional() @IsUrl({ protocols: ['https'], require_protocol: true }) receiptEvidenceUrl?: string;
}
export class CashConfirmationDto {
  @IsBoolean() agreed: boolean;
  @IsOptional() @IsString() @MaxLength(2000) disputeReason?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999999999999) confirmedAmount?: number;
}
