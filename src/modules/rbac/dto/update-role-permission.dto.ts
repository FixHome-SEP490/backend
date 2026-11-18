import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

export class UpdateRolePermissionDto {
  @ApiProperty({ description: 'true grants the permission to the service manager role, false removes it' })
  @IsBoolean()
  granted: boolean;
}
