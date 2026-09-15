// src/modules/parts-catalog/parts-catalog.controller.ts
import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
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
import { PartsCatalogService } from './parts-catalog.service';
import { FixHomePartResponseDto, QueryFixHomeCatalogDto } from './dto';
import { JwtAuthGuard, RolesGuard, PermissionGuard } from '../../common/guards';
import { RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';

@ApiTags('Parts Catalog')
@Controller('parts/catalog')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.TECHNICIAN, Role.SERVICE_MANAGER, Role.ADMIN)
@RequirePermission('service:read')
@ApiBearerAuth()
export class PartsCatalogController {
  constructor(private readonly partsCatalogService: PartsCatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Browse active FixHome parts catalog' })
  @ApiOkResponse({
    description: 'Active FixHome parts returned with pagination metadata',
    type: FixHomePartResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid pagination or search query' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Role or permission does not allow catalog access',
  })
  findCatalog(@Query() query: QueryFixHomeCatalogDto) {
    return this.partsCatalogService.findCatalog(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get active FixHome part detail by ID' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'FixHome part UUID' })
  @ApiOkResponse({
    description: 'Active FixHome part detail returned',
    type: FixHomePartResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid part UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Role or permission does not allow catalog access',
  })
  @ApiNotFoundResponse({ description: 'Active part not found' })
  findActiveById(@Param('id', ParseUUIDPipe) id: string) {
    return this.partsCatalogService.findActiveById(id);
  }
}
