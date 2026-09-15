import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsInt, IsNotEmpty, IsNumber, IsObject, IsOptional, IsString, IsUrl, Max, MaxLength, Min } from 'class-validator';
import { EvidenceType } from '../../shared/enums';

export class CheckInDto {
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @IsNumber() @Min(-180) @Max(180) lng: number;
  @IsNumber() @Min(0) @Max(100000) accuracyMeters: number;
  @IsOptional() @IsObject() deviceInfo?: Record<string, unknown>;
}
export class EvidenceDto {
  @IsEnum(EvidenceType) type: EvidenceType;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional() @IsDateString() capturedAt?: string;
}
export class CompletionRequestDto {
  @IsOptional() @IsString() @MaxLength(2000) completionNote?: string;
}
export class CompletionConfirmationDto {
  @IsOptional() @IsString() @MaxLength(2000) feedback?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
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
