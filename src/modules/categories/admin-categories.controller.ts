// src/modules/categories/admin-categories.controller.ts
import {
  Body,
  Delete,
  Get,
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
import { CategoriesService } from './categories.service';
import {
  CategoryResponseDto,
  CreateCategoryDto,
  UpdateCategoryDto,
} from './dto';
import { JwtAuthGuard, RolesGuard, PermissionGuard } from '../../common/guards';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { UpdateActiveStatusDto } from '../../shared/dto/update-active-status.dto';
import { User } from '../users/entities/user.entity';

@ApiTags('Admin / Service Categories')
@Controller(['admin/service-categories', 'admin/categories'])
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.ADMIN)
@RequirePermission('service:manage')
@ApiBearerAuth()
export class AdminCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate a category without deleting referenced data' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Category UUID' })
  @ApiOkResponse({ description: 'Category deactivated successfully', type: CategoryResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid category UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  @ApiNotFoundResponse({ description: 'Category not found' })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    return this.categoriesService.toggleStatus(id, false, user);
  }

  @Get()
  @ApiOperation({ summary: 'Admin: List active and inactive categories' })
  @ApiOkResponse({
    description: 'Categories returned with active and inactive entries',
    type: CategoryResponseDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  findAll() {
    return this.categoriesService.findAll(false);
  }

  @Post()
  @ApiOperation({ summary: 'Admin: Create a new service category' })
  @ApiCreatedResponse({ description: 'Category created successfully', type: CategoryResponseDto })
  @ApiBadRequestResponse({ description: 'Request validation failed' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  @ApiConflictResponse({ description: 'Category code or slug already exists' })
  async create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: User,
  ) {
    return this.categoriesService.create(dto, user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Admin: Update service category details' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Category UUID' })
  @ApiOkResponse({ description: 'Category updated successfully', type: CategoryResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid UUID or request validation failed' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  @ApiNotFoundResponse({ description: 'Category not found' })
  @ApiConflictResponse({ description: 'Category slug already exists' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: User,
  ) {
    return this.categoriesService.update(id, dto, user);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Admin: Toggle service category active status' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Category UUID' })
  @ApiOkResponse({
    description: 'Category status updated successfully',
    type: CategoryResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid UUID or status payload' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin service management permission required' })
  @ApiNotFoundResponse({ description: 'Category not found' })
  async toggleStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateActiveStatusDto,
    @CurrentUser() user: User,
  ) {
    return this.categoriesService.toggleStatus(id, dto.isActive, user);
  }
}
