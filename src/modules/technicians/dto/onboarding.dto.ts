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
  IsInt,
  IsIn,
  ValidateNested,
} from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';
import { IsPersonName } from '../../../shared/validation/text.validators';
import { Type } from 'class-transformer';
import { OnboardingStatus, Gender, VerificationStatus, SkillLevel, SKILL_LEVELS } from '../../../shared/enums';

// ── Step 1: Personal Info ──────────────────────────────────────────────

export class SavePersonalInfoDto {
  @ApiProperty({ example: 'Nguyễn Văn An', description: 'Full legal name' })
  @Trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  @IsNotEmpty()
  @IsPersonName()
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

export class SkillLevelItemDto {
  @ApiProperty({ example: 'uuid-1' })
  @IsUUID('4')
  serviceId: string;

  @ApiProperty({ enum: SkillLevel, description: 'Cấp độ tự khai; cấp độ thật do admin xác nhận sau khi xem bằng cấp' })
  @IsIn(SKILL_LEVELS)
  level: string;
}

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
  @IsInt()
  @Min(0)
  @Max(50)
  yearsExperience: number;

  @ApiPropertyOptional({ example: 'Chuyên sửa điện lạnh 5 năm kinh nghiệm' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @ApiPropertyOptional({ type: [SkillLevelItemDto], description: 'Cấp độ tự khai cho từng kỹ năng (thiếu thì mặc định INTERMEDIATE)' })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SkillLevelItemDto)
  skills?: SkillLevelItemDto[];
}

// ── Step 4: Address & Service Area ─────────────────────────────────────

export class ServiceAreaItemDto {
  // The columns hold 50 characters; longer codes failed at insert as a 500.
  @ApiProperty({ example: '01', description: 'Province code' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provinceCode: string;

  @ApiProperty({ example: '001', description: 'District code' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
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
  @Max(40)
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

  @ApiPropertyOptional({ example: 'Nguyễn Văn A' })
  fullName?: string;

  @ApiPropertyOptional({ example: '1995-05-15' })
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: Gender })
  gender?: Gender;

  @ApiPropertyOptional({ example: '012345678901' })
  citizenIdNumber?: string;

  @ApiPropertyOptional({ example: '0987654321' })
  phoneNumber?: string;

  @ApiPropertyOptional({ example: 3 })
  yearsExperience?: number;

  @ApiPropertyOptional({ example: 'Thợ sửa điện nước chuyên nghiệp' })
  bio?: string;

  @ApiPropertyOptional({ isArray: true, type: String })
  selectedServiceIds?: string[];

  @ApiPropertyOptional({ description: 'Kỹ năng đã chọn kèm cấp độ tự khai, cấp độ hiện hiệu lực và trạng thái xác nhận' })
  skills?: { serviceId: string; declaredLevel: string | null; level: string; verificationStatus: VerificationStatus }[];

  @ApiPropertyOptional({
    description: 'Giai đoạn xét duyệt: identity_review, visit_required, visit_scheduled, visit_blocked, profile_review, approved, identity_rejected, profile_rejected',
  })
  reviewStage?: string | null;

  @ApiPropertyOptional({ description: 'Lúc admin xác nhận danh tính' })
  identityVerifiedAt?: string;

  @ApiPropertyOptional({ description: 'Lý do từ chối hồ sơ (ở bước duyệt hồ sơ, khác lý do từ chối danh tính)' })
  profileRejectionReason?: string;

  @ApiPropertyOptional({ description: 'Lượt hẹn lên trụ sở đang chờ' })
  officeVisit?: { id: string; officeId: string; officeName: string; officeAddress: string; scheduledAt: string } | null;

  @ApiPropertyOptional({ description: 'Số điện thoại liên hệ quản lý dịch vụ, chỉ có khi bị khóa đặt lịch vì vắng' })
  supportPhone?: string;
}
