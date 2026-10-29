import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsUUID, Length, Min, IsString } from 'class-validator';

export enum InterruptionAction {
  DIRECT_REASSIGN_SOLO = 'DIRECT_REASSIGN_SOLO',
  CLOSE_FOR_REBOOK = 'CLOSE_FOR_REBOOK',
  REJECT_REQUEST = 'REJECT_REQUEST',
}

export class ResolveInterruptionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID('4') commandId: string;
  @ApiProperty({ minimum: 0 }) @IsInt() @Min(0) expectedCaseVersion: number;
  @ApiProperty({ enum: InterruptionAction }) @IsEnum(InterruptionAction) action: InterruptionAction;
  @ApiProperty({ minLength: 10, maxLength: 2000 }) @IsString() @Length(10, 2000) reason: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID('4') technicianId?: string;
}
