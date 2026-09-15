import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsUUID, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationDto } from '../../../shared/dto';
import { SupportCaseStatus, SupportCaseType } from '../../../shared/enums';
import { SUPPORT_CASE_MAX_SEARCH_LENGTH } from '../support-case.constants';

const trimString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class QuerySupportCasesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SupportCaseType })
  @IsOptional()
  @IsEnum(SupportCaseType)
  caseType?: SupportCaseType;

  @ApiPropertyOptional({ enum: SupportCaseStatus })
  @IsOptional()
  @IsEnum(SupportCaseStatus)
  status?: SupportCaseStatus;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  bookingId?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  serviceOrderId?: string;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  assignedManagerId?: string;

  @ApiPropertyOptional({ maxLength: SUPPORT_CASE_MAX_SEARCH_LENGTH })
  @IsOptional()
  @Transform(trimString)
  @MaxLength(SUPPORT_CASE_MAX_SEARCH_LENGTH)
  search?: string;
}
