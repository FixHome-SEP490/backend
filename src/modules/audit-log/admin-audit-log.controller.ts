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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, PermissionGuard } from '../../common/guards';
import { RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { AuditLogService } from './audit-log.service';
import { QueryAuditLogDto } from './dto/query-audit-log.dto';
import { AuditLogResponseDto } from './dto/audit-log-response.dto';

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
  @ApiOkResponse({
    description: 'Audit log list returned',
    type: AuditLogResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid audit log filters or pagination' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Audit read permission required' })
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
  @ApiParam({ name: 'id', format: 'uuid', description: 'Audit log UUID' })
  @ApiOkResponse({
    description: 'Audit log entry returned',
    type: AuditLogResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid audit log UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Audit read permission required' })
  @ApiNotFoundResponse({ description: 'Audit log entry not found' })
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    const entry = await this.auditLogService.findById(id);
    if (!entry) {
      throw new NotFoundException(`Audit log entry ${id} not found`);
    }
    return entry;
  }
}
