import { ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAGE } from '../../../shared/dto/page-size-query.dto';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { WalletTransactionType } from '../../../shared/enums';

export class QueryWalletTransactionsDto {
  @ApiPropertyOptional({ description: 'Trang cần lấy', default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Số lượng bản ghi mỗi trang', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({
    description: 'Lọc theo loại giao dịch',
    enum: WalletTransactionType,
  })
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;
}
