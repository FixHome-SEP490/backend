import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class StopReplaceRequestDto {
  @ApiProperty({ minLength: 10, maxLength: 2000 })
  @IsString()
  @Length(10, 2000)
  reason: string;
}
