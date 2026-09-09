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
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './dto';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { UpdateActiveStatusDto } from '../../shared/dto/update-active-status.dto';

@ApiTags('Admin / Service Categories')
@Controller(['admin/service-categories', 'admin/categories'])
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SERVICE_MANAGER)
@ApiBearerAuth()
export class AdminCategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Delete(':id')
  @ApiOperation({ summary: 'Deactivate a category without deleting referenced data' })
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.categoriesService.toggleStatus(id, false);
  }

  @Get()
  @ApiOperation({ summary: 'Admin: List active and inactive categories' })
  findAll() {
    return this.categoriesService.findAll(false);
  }

  @Post()
  @ApiOperation({ summary: 'Admin: Create a new service category' })
  @ApiResponse({ status: 201, description: 'Category created successfully' })
  @ApiResponse({ status: 409, description: 'Category code already exists' })
  async create(@Body() dto: CreateCategoryDto) {
    return this.categoriesService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Admin: Update service category details' })
  @ApiResponse({ status: 200, description: 'Category updated successfully' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categoriesService.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Admin: Toggle service category active status' })
  @ApiResponse({
    status: 200,
    description: 'Category status updated successfully',
  })
  async toggleStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateActiveStatusDto,
  ) {
    return this.categoriesService.toggleStatus(id, dto.isActive);
  }
}
