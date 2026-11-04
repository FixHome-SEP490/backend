import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class ListWarehouseRowsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  offset = 0;
}
