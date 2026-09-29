import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetSupportCaseHoldDto {
  @ApiProperty({ description: 'true stops the order from completing automatically while the case is open' })
  @IsBoolean()
  hold: boolean;
}
