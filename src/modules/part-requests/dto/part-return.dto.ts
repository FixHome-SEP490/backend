import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

export class PartReturnDto {
  @IsInt() @Min(1) @Max(100)
  quantity: number;

  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion: number;

  @IsString() @Length(8, 128) @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey: string;
}

/** observedQty counts only undamaged, acceptable units; this command accepts none. */
export class PartReturnDiscrepancyDto {
  @IsInt() @Min(1) @Max(100)
  declaredQty: number;

  @IsInt() @Min(0) @Max(100)
  observedQty: number;

  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion: number;

  @IsString() @Length(8, 128) @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey: string;

  @IsString() @Length(5, 300) @Matches(/\S/)
  reason: string;
}
