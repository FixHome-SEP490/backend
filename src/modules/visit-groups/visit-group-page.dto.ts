import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageSizeQueryDto } from '../../shared/dto/page-size-query.dto';
import { VISIT_GROUP_READ_STATUSES, VISIT_GROUP_TECHNICIAN_TABS } from './visit-group-read';

export class VisitGroupMyPageQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ enum: VISIT_GROUP_READ_STATUSES })
  @IsOptional()
  @IsIn(VISIT_GROUP_READ_STATUSES)
  status?: (typeof VISIT_GROUP_READ_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Device or service name contains; maximum 100 characters' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class VisitGroupAssignedPageQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ enum: VISIT_GROUP_TECHNICIAN_TABS, default: 'all' })
  @IsOptional()
  @IsIn(VISIT_GROUP_TECHNICIAN_TABS)
  tab?: (typeof VISIT_GROUP_TECHNICIAN_TABS)[number];
}
