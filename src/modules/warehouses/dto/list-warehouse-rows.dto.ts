import { Type } from 'class-transformer';
import { IsInt, Max, Min, IsOptional, IsUUID } from 'class-validator';

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

/** W-11: the adjustment form reads the chosen SKU's row, whatever page of the stock list it is on. */
export class ListWarehouseStockDto extends ListWarehouseRowsDto {
  @IsOptional()
  @IsUUID('all')
  partId?: string;
}
