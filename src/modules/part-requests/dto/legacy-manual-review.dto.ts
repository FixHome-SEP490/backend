import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, IsUUID, Length, Matches, Max, Min, ValidateIf } from 'class-validator';

export const LEGACY_REVIEW_STATUSES = ['INVESTIGATING', 'PHYSICALLY_VERIFIED', 'DISCREPANCY_RECORDED'] as const;
export type LegacyReviewStatus = typeof LEGACY_REVIEW_STATUSES[number];
const normalizeUuid = ({ value }: { value: unknown }) => typeof value === 'string' ? value.toLowerCase() : value;
const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;
// Notes contain operational reasons only, not contact details or evidence URLs.
const privateNote = /^(?![\s\S]*(?:https?:\/\/|www\.|@|\+?\d[\d .()-]{8,}\d))[^\x00-\x1f\x7f]+$/i;

export class LegacyManualReviewDto {
  @Transform(normalizeUuid) @IsUUID()
  commandId: string;

  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER - 1)
  expectedVersion: number;

  @IsIn(LEGACY_REVIEW_STATUSES)
  status: LegacyReviewStatus;

  @Transform(trim) @IsString() @Length(5, 300) @Matches(privateNote)
  reason: string;

  @ValidateIf((_o, value) => value !== undefined) @Transform(normalizeUuid) @IsUUID()
  evidenceReferenceId?: string;

  @ValidateIf((_o, value) => value !== undefined) @IsInt() @Min(0) @Max(100)
  observedQty?: number;

  @ValidateIf((_o, value) => value !== undefined) @Transform(normalizeUuid) @IsUUID()
  correctsEventId?: string;

  @ValidateIf((_o, value) => value !== undefined) @Transform(trim) @IsString() @Length(5, 300) @Matches(privateNote)
  correctionReason?: string;
}
