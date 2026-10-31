import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const DELAY_NOTICE_MINUTES = [30, 60, 90, 120] as const;
export const DELAY_DECISIONS = ['wait', 'switch', 'cancel'] as const;
export type DelayDecision = (typeof DELAY_DECISIONS)[number];

export class DelayNoticeDto {
  @ApiProperty({ enum: DELAY_NOTICE_MINUTES }) @IsIn(DELAY_NOTICE_MINUTES) delayMinutes: number;
}

export class DelayDecisionDto {
  @ApiProperty({ enum: DELAY_DECISIONS }) @IsIn(DELAY_DECISIONS) decision: DelayDecision;
}
