import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageSizeQueryDto } from '../../../shared/dto/page-size-query.dto';
import { MY_RETURN_GROUPS, MyReturnGroupFilter } from '../part-return-groups';

/**
 * GET /part-returns/mine. Without `status` the endpoint answers as it always did
 * (open rows + meta.completedQty), so older apps keep working; with it the list is
 * one of the three groups the technician page shows, paged.
 */
export class MyPartReturnsQueryDto extends PageSizeQueryDto {
  @ApiPropertyOptional({ enum: [...MY_RETURN_GROUPS, 'all'] })
  @IsOptional()
  @IsIn([...MY_RETURN_GROUPS, 'all'])
  status?: MyReturnGroupFilter;
}
