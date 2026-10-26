import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { UUID_REGEX } from '../../bookings/booking.dto';

/**
 * Why an approved device of a visit could not be made to work (PO 21/10/2026).
 * The technician taps one; the label is what the customer and the managers read.
 */
export const REPAIR_FAILURE_REASONS = {
  no_part: 'Không có linh kiện thay thế phù hợp',
  beyond_repair: 'Máy hỏng nặng, không sửa được',
  needs_workshop: 'Cần mang về xưởng để sửa',
  other: 'Lý do khác',
} as const;
export type RepairFailureReason = keyof typeof REPAIR_FAILURE_REASONS;

export class RepairFailedPartDto {
  @ApiProperty({ description: 'A part request of this order the technician received' })
  @Matches(UUID_REGEX, { message: 'partRequestId must be a valid UUID' })
  partRequestId: string;

  @ApiProperty({ enum: ['installed', 'returned'], description: 'installed: fitted to the device; returned: going back to the FixHome warehouse' })
  @IsIn(['installed', 'returned'])
  outcome: 'installed' | 'returned';
}

export class RepairFailedDto {
  @ApiProperty({ enum: Object.keys(REPAIR_FAILURE_REASONS) })
  @IsIn(Object.keys(REPAIR_FAILURE_REASONS))
  reason: RepairFailureReason;

  @ApiPropertyOptional({ maxLength: 500, description: 'A few words more, optional' })
  @IsOptional() @IsString() @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ type: [RepairFailedPartDto], maxItems: 20, description: 'Every part received for this order, fitted or going back' })
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => RepairFailedPartDto)
  parts?: RepairFailedPartDto[];

  @ApiPropertyOptional({ type: [String], maxItems: 3, description: 'IDs of private ADDITIONAL photos uploaded by this technician to this order before reporting failure; never URLs' })
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ArrayUnique() @Matches(UUID_REGEX, { each: true })
  photoEvidenceIds?: string[];
}
