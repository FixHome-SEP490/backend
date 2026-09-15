// src/modules/services/admin-services.controller.ts
import {
  Body,
  Delete,
  Get,
  Query,
  Controller,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
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
import { ServicesService } from './services.service';
import {
  CreateServiceDto,
  QueryServicesDto,
  ServiceResponseDto,
  UpdateServiceDto,
} from './dto';
import { JwtAuthGuard, RolesGuard, PermissionGuard } from '../../common/guards';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { UpdateActiveStatusDto } from '../../shared/dto/update-active-status.dto';
import { User } from '../users/entities/user.entity';

@ApiTags('Admin / Services')
@Controller('admin/services')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.ADMIN)
@RequirePermission('service:manage')
@ApiBearerAuth()
export class AdminServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate a service without deleting referenced data' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Service UUID' })
  @ApiOkResponse({ description: 'Service deactivated successfully', type: ServiceResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid service UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  @ApiNotFoundResponse({ description: 'Service not found' })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.servicesService.toggleStatus(id, false, user);
  }

  @Get()
  @ApiOperation({ summary: 'Admin: Browse active and inactive services' })
  @ApiOkResponse({
    description: 'Services returned with pagination metadata',
    type: ServiceResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid pagination or service filters' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  findAll(@Query() query: QueryServicesDto) {
    return this.servicesService.findServices(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: Read service including inactive data' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Service UUID' })
  @ApiOkResponse({ description: 'Service detail returned', type: ServiceResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid service UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  @ApiNotFoundResponse({ description: 'Service not found' })
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.servicesService.findById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Admin: Create a new service' })
  @ApiCreatedResponse({ description: 'Service created successfully', type: ServiceResponseDto })
  @ApiBadRequestResponse({ description: 'Request validation or price validation failed' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  @ApiNotFoundResponse({ description: 'Category not found' })
  @ApiConflictResponse({ description: 'Service code or slug already exists' })
  async create(
    @Body() dto: CreateServiceDto,
    @CurrentUser() user: User,
  ) {
    return this.servicesService.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Admin: Update service details and price ranges' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Service UUID' })
  @ApiOkResponse({ description: 'Service updated successfully', type: ServiceResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid UUID, request, or price range' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  @ApiNotFoundResponse({ description: 'Service or category not found' })
  @ApiConflictResponse({ description: 'Service slug already exists' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceDto,
    @CurrentUser() user: User,
  ) {
    return this.servicesService.update(id, dto, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Admin: Toggle service active/inactive status' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Service UUID' })
  @ApiOkResponse({
    description: 'Service status updated successfully',
    type: ServiceResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid UUID or status payload' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  @ApiNotFoundResponse({ description: 'Service not found' })
  async toggleStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateActiveStatusDto,
    @CurrentUser() user: User,
  ) {
    return this.servicesService.toggleStatus(id, dto.isActive, user);
  }
}
