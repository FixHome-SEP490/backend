// src/modules/audit-log/admin-audit-log.controller.ts
import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, PermissionGuard } from '../../common/guards';
import { RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { AuditLogService } from './audit-log.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';

@ApiTags('Admin / Audit Logs')
@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.ADMIN)
@RequirePermission('audit:read')
@ApiBearerAuth()
export class AdminAuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  @ApiOperation({
    summary: 'Admin: List audit logs with pagination and filters',
    description:
      'Append-only audit trail. Supports filtering by resourceType, actorUserId, and action. ' +
      'No update or delete endpoint is exposed.',
  })
  @ApiResponse({ status: 200, description: 'Audit log list returned' })
  async findAll(@Query() query: QueryAuditLogDto) {
    const { data, total } = await this.auditLogService.findAll({
      page: query.page,
      limit: query.limit,
      resourceType: query.resourceType,
      actorUserId: query.actorUserId,
      action: query.action,
    });
    return {
      data,
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: Get a single audit log entry by ID' })
  @ApiParam({ name: 'id', description: 'Audit log UUID' })
  @ApiResponse({ status: 200, description: 'Audit log entry returned' })
  @ApiResponse({ status: 404, description: 'Audit log entry not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const entry = await this.auditLogService.findById(id);
    if (!entry) {
      throw new NotFoundException(`Audit log entry ${id} not found`);
    }
    return entry;
  }
}
