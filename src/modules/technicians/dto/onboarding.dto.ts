// src/modules/technicians/dto/onboarding.dto.ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  IsArray,
  ArrayMinSize,
  IsUUID,
} from 'class-validator';
import { OnboardingStatus, Gender, VerificationStatus } from '../../../shared/enums';

// ── Step 1: Personal Info ──────────────────────────────────────────────

export class SavePersonalInfoDto {
  @ApiProperty({ example: 'Nguyễn Văn An', description: 'Full legal name' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @IsNotEmpty()
  fullName: string;

  @ApiProperty({ example: '1995-06-15', description: 'Date of birth (ISO date)' })
  @IsDateString()
  @IsNotEmpty()
  dateOfBirth: string;

  @ApiProperty({ enum: Gender, example: Gender.MALE })
  @IsEnum(Gender)
  gender: Gender;

  @ApiProperty({ example: '079123456789', description: '12-digit CCCD number' })
  @IsString()
  @Matches(/^\d{12}$/, {
    message: 'citizenIdNumber must be exactly 12 digits',
  })
  citizenIdNumber: string;

  @ApiPropertyOptional({ example: '0912345678', description: 'Vietnamese phone number' })
  @IsOptional()
  @IsString()
  @Matches(/^0[35789][0-9]{8}$/, {
    message: 'phoneNumber must be a valid Vietnamese phone number',
  })
  phoneNumber?: string;
}

// ── Step 3: Skills Selection ───────────────────────────────────────────

export class SaveSkillsDto {
  @ApiProperty({
    description: 'At least 1 service ID the technician specializes in',
    type: [String],
    example: ['uuid-1', 'uuid-2'],
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Phải chọn ít nhất 1 kỹ năng chuyên môn' })
  @IsUUID('4', { each: true })
  serviceIds: string[];

  @ApiProperty({ example: 3, description: 'Years of experience' })
  @IsNumber()
  @Min(0)
  @Max(50)
  yearsExperience: number;

  @ApiPropertyOptional({ example: 'Chuyên sửa điện lạnh 5 năm kinh nghiệm' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;
}

// ── Step 4: Address & Service Area ─────────────────────────────────────

export class ServiceAreaItemDto {
  @ApiProperty({ example: '01', description: 'Province code' })
  @IsString()
  @IsNotEmpty()
  provinceCode: string;

  @ApiProperty({ example: '001', description: 'District code' })
  @IsString()
  @IsNotEmpty()
  districtCode: string;
}

export class SaveAddressDto {
  @ApiProperty({ example: '123 Đường ABC, Phường XYZ', description: 'Full street address' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  fullAddress: string;

  @ApiPropertyOptional({ example: 10.7769, description: 'Latitude' })
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ApiPropertyOptional({ example: 106.7009, description: 'Longitude' })
  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ApiProperty({ description: 'Service areas (districts)', type: [ServiceAreaItemDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'Phải chọn ít nhất 1 khu vực phục vụ' })
  serviceAreas: ServiceAreaItemDto[];

  @ApiPropertyOptional({ example: 10, description: 'Service radius in km' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  serviceRadiusKm?: number;
}

// ── Response ───────────────────────────────────────────────────────────

export class OnboardingStatusResponseDto {
  @ApiProperty({ enum: OnboardingStatus })
  onboardingStatus: OnboardingStatus;

  @ApiPropertyOptional({ enum: VerificationStatus })
  verificationStatus?: VerificationStatus;

  @ApiProperty({ example: 1, description: 'Current step (1-5)' })
  currentStep: number;

  @ApiPropertyOptional({ description: 'Rejection reason if rejected' })
  rejectionReason?: string | null;

  @ApiProperty({ description: 'Whether personal info is completed' })
  personalInfoCompleted: boolean;

  @ApiProperty({ description: 'Whether KYC documents are submitted' })
  kycSubmitted: boolean;

  @ApiProperty({ description: 'Whether skills are selected' })
  skillsSelected: boolean;

  @ApiProperty({ description: 'Whether address is set' })
  addressSet: boolean;

  @ApiPropertyOptional({ description: 'Technician address' })
  fullAddress?: string;

  @ApiPropertyOptional({ description: 'Technician latitude' })
  latitude?: number;

  @ApiPropertyOptional({ description: 'Technician longitude' })
  longitude?: number;

  @ApiPropertyOptional({ description: 'Service radius in km' })
  serviceRadiusKm?: number;

  @ApiPropertyOptional({ description: 'Service areas' })
  serviceAreas?: { provinceCode: string; districtCode: string }[];
}
