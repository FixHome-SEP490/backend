import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, Equals, IsArray, IsIn, IsString, IsUUID, Length } from 'class-validator';

export const DELAY_NOTICE_MINUTES = [30, 60, 90, 120] as const;
export const DELAY_DECISIONS = ['wait', 'switch', 'cancel'] as const;
export type DelayDecision = (typeof DELAY_DECISIONS)[number];
/** Why the technician cannot reach the next order in time (PO 31/10/2026). */
export const DELAY_REASON_CODES = ['new_fault_found', 'waiting_parts', 'repair_longer', 'other'] as const;
export type DelayReasonCode = (typeof DELAY_REASON_CODES)[number];

/** What a technician must give to report a late or released next order: a reason, 1 to 3 photos and a confirmation. */
export class DelayReportDto {
  @ApiProperty({ enum: DELAY_REASON_CODES }) @IsIn(DELAY_REASON_CODES) reasonCode: DelayReasonCode;
  @ApiProperty({ minLength: 10, maxLength: 2000 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @Length(10, 2000) reason: string;
  @ApiProperty({ type: [String], description: 'ADDITIONAL evidence photos of the job still under repair, 1 to 3.' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ArrayUnique() @IsUUID('4', { each: true }) evidenceIds: string[];
  @ApiProperty({ description: 'The technician confirms the report is true.' }) @Equals(true) confirm: boolean;
}

export class DelayNoticeDto extends DelayReportDto {
  @ApiProperty({ enum: DELAY_NOTICE_MINUTES }) @IsIn(DELAY_NOTICE_MINUTES) delayMinutes: number;
}

export class DelayDecisionDto {
  @ApiProperty({ enum: DELAY_DECISIONS }) @IsIn(DELAY_DECISIONS) decision: DelayDecision;
}
