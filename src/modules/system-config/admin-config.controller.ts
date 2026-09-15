// src/modules/system-config/admin-config.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { AdminConfigService } from './admin-config.service';
import { UpdateConfigDto } from './dto/update-config.dto';
import { QueryConfigDto } from './dto/query-config.dto';
import { SystemConfigResponseDto } from './dto/system-config-response.dto';

@ApiTags('Admin / System Config')
@Controller('admin/config')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.ADMIN)
@RequirePermission('config:read')
@ApiBearerAuth()
export class AdminConfigController {
  constructor(private readonly adminConfigService: AdminConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Admin: List all system config keys with effect-status metadata',
    description:
      'Returns the complete config registry. Each key is annotated with effectStatus: ' +
      'ACTIVE (consumed at runtime), TO_WIRE (hard-coded consumer remains — see consumerEvidence), ' +
      'NOT_IMPLEMENTED (feature not built yet), STALE_REVIEW (semantics corrected per v1.4).',
  })
  @ApiOkResponse({
    description: 'Config registry returned',
    type: SystemConfigResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid config search query' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin config permission required' })
  async findAll(@Query() query: QueryConfigDto) {
    return this.adminConfigService.findAll(query.search);
  }

  @Get(':key')
  @ApiOperation({ summary: 'Admin: Get a single config key with effect metadata' })
  @ApiParam({ name: 'key', example: 'commission.rate_bps' })
  @ApiOkResponse({
    description: 'Config key returned',
    type: SystemConfigResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid config key' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin config permission required' })
  @ApiNotFoundResponse({ description: 'Config key not found' })
  async findOne(@Param('key') key: string) {
    return this.adminConfigService.findOne(key);
  }

  @Patch(':key')
  @RequirePermission('config:update')
  @ApiOperation({
    summary: 'Admin: Update a config key value (typed/per-key validation)',
    description:
      'Validates the value against the key\'s declared type and allowed range before saving. ' +
      'Writes an audit log entry with before/after values.',
  })
  @ApiParam({ name: 'key', example: 'commission.rate_bps' })
  @ApiOkResponse({
    description: 'Config key updated',
    type: SystemConfigResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Validation failed for key type/range' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Config update permission required' })
  @ApiNotFoundResponse({ description: 'Config key not found' })
  async update(
    @Param('key') key: string,
    @Body() dto: UpdateConfigDto,
    @CurrentUser() user: User,
  ) {
    return this.adminConfigService.update(key, dto.value, user.id, user.role);
  }
}
