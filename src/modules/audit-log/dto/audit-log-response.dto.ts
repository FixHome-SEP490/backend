import { ApiProperty } from '@nestjs/swagger';
import { AuditLog } from '../entities/audit-log.entity';

export class AuditLogResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorUserId: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'admin' })
  actorRole: string | null;

  @ApiProperty({ example: 'CONFIG_UPDATE' })
  action: string;

  @ApiProperty({ example: 'system_config' })
  resourceType: string;

  @ApiProperty({ type: String, nullable: true })
  resourceId: string | null;

  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description: 'Opaque JSON snapshot before the audited action.',
  })
  before: AuditLog['before'];

  @ApiProperty({
    type: 'object',
    nullable: true,
    additionalProperties: true,
    description: 'Opaque JSON snapshot after the audited action.',
  })
  after: AuditLog['after'];

  @ApiProperty({ type: String, nullable: true })
  ip: string | null;

  @ApiProperty({ type: String, nullable: true })
  userAgent: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
}
