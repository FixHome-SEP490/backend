// src/modules/parts-catalog/admin-parts.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { PartsCatalogService } from './parts-catalog.service';
import {
  CreateFixHomePartDto,
  FixHomePartResponseDto,
  QueryFixHomePartsDto,
  UpdateFixHomePartDto,
} from './dto';
import { JwtAuthGuard, RolesGuard, PermissionGuard } from '../../common/guards';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { UpdateActiveStatusDto } from '../../shared/dto/update-active-status.dto';
import { User } from '../users/entities/user.entity';

@ApiTags('Admin / Parts')
@Controller('admin/parts')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.ADMIN)
@RequirePermission('service:manage')
@ApiBearerAuth()
export class AdminPartsController {
  constructor(private readonly partsCatalogService: PartsCatalogService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: Browse active and inactive FixHome parts' })
  @ApiOkResponse({
    description: 'FixHome parts returned with pagination metadata',
    type: FixHomePartResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid pagination, search, or active-status query' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Admin role and service:manage permission required',
  })
  findAll(@Query() query: QueryFixHomePartsDto) {
    return this.partsCatalogService.findAdmin(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: Read FixHome part including inactive data' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'FixHome part UUID' })
  @ApiOkResponse({
    description: 'FixHome part detail returned',
    type: FixHomePartResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid part UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Admin role and service:manage permission required',
  })
  @ApiNotFoundResponse({ description: 'Part not found' })
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.partsCatalogService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Admin: Create a new FixHome part' })
  @ApiCreatedResponse({
    description: 'Part created successfully',
    type: FixHomePartResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Request validation failed' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Admin role and service:manage permission required',
  })
  @ApiConflictResponse({ description: 'Normalized part SKU already exists' })
  create(@Body() dto: CreateFixHomePartDto, @CurrentUser() user: User) {
    return this.partsCatalogService.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Admin: Update FixHome part details' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'FixHome part UUID' })
  @ApiOkResponse({
    description: 'Part updated successfully',
    type: FixHomePartResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid UUID or request validation failed',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Admin role and service:manage permission required',
  })
  @ApiNotFoundResponse({ description: 'Part not found' })
  @ApiConflictResponse({ description: 'Normalized part SKU already exists' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFixHomePartDto,
    @CurrentUser() user: User,
  ) {
    return this.partsCatalogService.update(id, dto, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Admin: Activate/deactivate a FixHome part' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'FixHome part UUID' })
  @ApiOkResponse({
    description: 'Part status updated successfully',
    type: FixHomePartResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid UUID or status payload' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Admin role and service:manage permission required',
  })
  @ApiNotFoundResponse({ description: 'Part not found' })
  toggleStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateActiveStatusDto,
    @CurrentUser() user: User,
  ) {
    return this.partsCatalogService.toggleStatus(id, dto.isActive, user);
  }
}
