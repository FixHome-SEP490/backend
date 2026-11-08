import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SKILL_LEVELS, SkillLevel } from '../../../shared/enums';
import { Trim } from '../../../shared/validation/input.transforms';
import { OfficeVisitStatus } from '../entities/office-visit.entity';

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateVisitOfficeDto {
  @ApiProperty({ example: 'Trụ sở Quận 1' })
  @IsString() @Trim() @IsNotEmpty() @MaxLength(120)
  name: string;

  @ApiProperty({ example: '12 Lê Lợi, Bến Nghé, Quận 1, TP.HCM' })
  @IsString() @Trim() @IsNotEmpty() @MaxLength(500)
  address: string;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-90) @Max(90)
  latitude?: number | null;

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-180) @Max(180)
  longitude?: number | null;

  @ApiPropertyOptional() @IsOptional() @IsString() @Trim() @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional() @IsOptional() @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ example: [1, 2, 3, 4, 5], description: '1 = thứ hai … 7 = chủ nhật' })
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7) @IsInt({ each: true }) @Min(1, { each: true }) @Max(7, { each: true })
  visitDays?: number[];

  @ApiPropertyOptional({ example: '08:00' }) @IsOptional() @Matches(HH_MM, { message: 'openTime must be HH:mm' })
  openTime?: string;

  @ApiPropertyOptional({ example: '17:00' }) @IsOptional() @Matches(HH_MM, { message: 'closeTime must be HH:mm' })
  closeTime?: string;

  @ApiPropertyOptional({ example: '11:30', nullable: true }) @IsOptional() @Matches(HH_MM, { message: 'lunchStart must be HH:mm' })
  lunchStart?: string | null;

  @ApiPropertyOptional({ example: '13:30', nullable: true }) @IsOptional() @Matches(HH_MM, { message: 'lunchEnd must be HH:mm' })
  lunchEnd?: string | null;

  @ApiPropertyOptional({ example: 30 }) @IsOptional() @IsInt() @Min(10) @Max(240)
  slotMinutes?: number;

  @ApiPropertyOptional({ example: 2 }) @IsOptional() @IsInt() @Min(1) @Max(50)
  slotCapacity?: number;
}

export class UpdateVisitOfficeDto extends PartialType(CreateVisitOfficeDto) {}

export class BookOfficeVisitDto {
  @ApiProperty() @IsUUID('4')
  officeId: string;

  @ApiProperty({ example: '2026-11-10T07:00:00.000Z', description: 'Đầu lượt hẹn, lấy từ danh sách lượt còn trống' })
  @IsDateString()
  scheduledAt: string;
}

export class MarkOfficeVisitDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Trim() @MaxLength(1000)
  note?: string;
}

export class QueryOfficeVisitsDto {
  @ApiPropertyOptional({ enum: OfficeVisitStatus }) @IsOptional() @IsEnum(OfficeVisitStatus)
  status?: OfficeVisitStatus;

  @ApiPropertyOptional() @IsOptional() @IsUUID('4')
  officeId?: string;

  @ApiPropertyOptional({ example: '2026-11-10', description: 'Ngày hẹn theo giờ Việt Nam' })
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

export class ReviewSkillDecisionDto {
  @ApiProperty() @IsUUID('4')
  skillId: string;

  @ApiProperty({ enum: SkillLevel, description: 'Cấp độ được xác nhận từ bằng cấp' }) @IsIn(SKILL_LEVELS)
  level: string;

  @ApiProperty({ description: 'false: chưa xác nhận kỹ năng này (không được nhận việc theo kỹ năng đó)' }) @IsBoolean()
  approved: boolean;
}

export class ApproveProfileDto {
  @ApiProperty({ type: [ReviewSkillDecisionDto] })
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true }) @Type(() => ReviewSkillDecisionDto)
  skills: ReviewSkillDecisionDto[];
}

export class RejectProfileDto {
  @ApiProperty({ example: 'Bản công chứng bằng cấp không rõ, vui lòng bổ sung.' })
  @IsString() @Trim() @MaxLength(2000) @MinLength(5)
  reason: string;
}
