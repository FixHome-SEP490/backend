import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class InterruptionDraftQueryDto {
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.split(',') : value)
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ArrayUnique() @IsUUID('4', { each: true })
  sourceBookingIds?: string[];
}
