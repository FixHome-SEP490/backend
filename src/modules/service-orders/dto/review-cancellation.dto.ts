import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Service Manager / Admin decision on a recorded cancellation (BRX-032 to BRX-034). */
export class ReviewCancellationDto {
  @ApiPropertyOptional({ description: 'No longer accepted (PO 09/10/2026): a cancellation costs reputation points by itself; staff adjust points on /reputation' })
  @IsOptional()
  @IsBoolean()
  confirmViolation?: boolean;

  @ApiPropertyOptional({ description: 'Waive a strike recorded before reputation points replaced strikes' })
  @IsOptional()
  @IsBoolean()
  waiveStrike?: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  waiveReason?: string;

  @ApiPropertyOptional({ enum: ['GRANTED', 'REJECTED'], description: 'Monetary compensation is not supported; only REJECTED is accepted (BRX-034)' })
  @IsOptional()
  @IsIn(['GRANTED', 'REJECTED'])
  compensationDecision?: 'GRANTED' | 'REJECTED';

  @ApiPropertyOptional({ description: 'Grant the technician a Priority Boost (verified-arrival customer cancellation)' })
  @IsOptional()
  @IsBoolean()
  grantPriorityBoost?: boolean;
}
