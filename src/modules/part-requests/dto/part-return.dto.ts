import { IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';

export class PartReturnDto {
  @IsInt() @Min(1) @Max(100)
  quantity: number;

  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER)
  expectedVersion: number;

  @IsString() @Length(8, 128) @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey: string;
}
