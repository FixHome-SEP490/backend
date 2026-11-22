import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../../shared/dto';

export class QueryCheckinFaceReviewsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ['pending', 'approved', 'rejected'], default: 'pending' })
  @IsOptional()
  @IsIn(['pending', 'approved', 'rejected'])
  status?: 'pending' | 'approved' | 'rejected';
}

export class ReviewCheckinFaceDto {
  @ApiProperty({ description: 'true: the face is the registered technician; false: ask the technician to retake' })
  @IsBoolean()
  approve: boolean;

  @ApiPropertyOptional({ description: 'Required (at least 5 characters) when rejecting' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
