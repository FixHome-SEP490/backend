import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsOptional, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';
import { VISIT_GROUP_DEVICE_LIMIT } from '../../visit-groups/visit-group.dto';

export class InterruptionDraftQueryDto {
  @IsOptional()
  @Transform(({ value }) => typeof value === 'string' ? value.split(',') : value)
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(VISIT_GROUP_DEVICE_LIMIT) @ArrayUnique() @IsUUID('4', { each: true })
  sourceBookingIds?: string[];
}
