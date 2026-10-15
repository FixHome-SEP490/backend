import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../../../shared/dto';
import { Gender, VerificationStatus } from '../../../shared/enums';
import { Trim } from '../../../shared/validation/input.transforms';
import {
  IsAddressText,
  IsPersonName,
  NoUnsafeText,
} from '../../../shared/validation/text.validators';
import type { CustomerKycDocumentType } from '../entities/customer-verification-document.entity';

/** Customers send photos of the card only: no PDF, no video (PO 14/10/2026). */
export const CUSTOMER_KYC_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const CUSTOMER_KYC_DOCUMENT_TYPES: CustomerKycDocumentType[] = [
  'citizen_id_front',
  'citizen_id_back',
];
export const CUSTOMER_KYC_MAX_FILE_SIZE = 10 * 1024 * 1024;

export class RequestCustomerKycUploadUrlDto {
  @ApiProperty({ enum: CUSTOMER_KYC_MIME_TYPES, example: 'image/jpeg' })
  @IsString()
  @IsIn(CUSTOMER_KYC_MIME_TYPES, {
    message: 'mimeType must be one of image/jpeg, image/png, image/webp',
  })
  mimeType: string;
}

export class CustomerKycDocumentDto {
  @ApiProperty({ enum: CUSTOMER_KYC_DOCUMENT_TYPES, example: 'citizen_id_front' })
  @IsIn(CUSTOMER_KYC_DOCUMENT_TYPES, {
    message: 'documentType must be citizen_id_front or citizen_id_back',
  })
  documentType: CustomerKycDocumentType;

  @ApiProperty({
    example: 'kyc/<userId>/<uuid>.jpg',
    description: 'storageObjectPath returned by the upload-url call; must be under kyc/<your id>/',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  storageObjectPath: string;

  @ApiProperty({ example: 'cccd-mat-truoc.jpg' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @NoUnsafeText()
  @Matches(/^[^\\/]+\.(jpe?g|png|webp)$/iu, {
    message: 'fileName must end in .jpg, .jpeg, .png or .webp',
  })
  fileName: string;

  @ApiProperty({ example: 1048576, description: 'Bytes, at most 10 MB' })
  @IsInt()
  @Min(1)
  @Max(CUSTOMER_KYC_MAX_FILE_SIZE, { message: 'fileSize cannot exceed 10MB' })
  fileSize: number;

  @ApiProperty({ enum: CUSTOMER_KYC_MIME_TYPES, example: 'image/jpeg' })
  @IsString()
  @IsIn(CUSTOMER_KYC_MIME_TYPES, {
    message: 'mimeType must be one of image/jpeg, image/png, image/webp',
  })
  mimeType: string;
}

/**
 * The customer confirms their details as printed on the citizen ID card and
 * attaches both sides of it. The same field rules as technician onboarding.
 */
export class SubmitCustomerVerificationDto {
  @ApiProperty({ example: 'Nguyễn Văn An' })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @IsPersonName()
  fullName: string;

  @ApiProperty({ example: '1995-06-15', description: 'YYYY-MM-DD' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateOfBirth must be a date in YYYY-MM-DD form' })
  @IsISO8601({ strict: true }, { message: 'dateOfBirth must be a real calendar date' })
  dateOfBirth: string;

  @ApiProperty({ enum: Gender, example: Gender.MALE })
  @IsEnum(Gender)
  gender: Gender;

  @ApiProperty({ example: '079123456789', description: '12 chữ số' })
  @IsString()
  @Matches(/^\d{12}$/, { message: 'citizenIdNumber must be exactly 12 digits' })
  citizenIdNumber: string;

  @ApiProperty({ example: '12 Nguyễn Trãi, Phường Bến Thành, TP. Hồ Chí Minh' })
  @Trim()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  @IsAddressText()
  address: string;

  @ApiProperty({ type: [CustomerKycDocumentDto], description: 'Exactly one citizen_id_front and one citizen_id_back' })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => CustomerKycDocumentDto)
  documents: CustomerKycDocumentDto[];
}

export class QueryCustomerVerificationsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  status?: VerificationStatus;

  @ApiPropertyOptional({ description: 'Tên (không phân biệt dấu), email, số điện thoại hoặc số CCCD' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @NoUnsafeText()
  search?: string;
}
