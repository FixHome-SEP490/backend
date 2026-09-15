// src/modules/categories/categories.controller.ts
import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CategoriesService } from './categories.service';
import { CategoryResponseDto } from './dto';

@ApiTags('Service Categories')
@Controller(['service-categories', 'categories'])
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'Public: List active service categories' })
  @ApiOkResponse({
    description: 'Categories fetched successfully',
    type: CategoryResponseDto,
    isArray: true,
  })
  async findAll() {
    return this.categoriesService.findAll(true);
  }

  @Get(':idOrSlug')
  @ApiOperation({ summary: 'Public: Get category details with services by ID or slug' })
  @ApiOkResponse({
    description: 'Category detail fetched successfully',
    type: CategoryResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Category not found' })
  async findByIdOrSlug(@Param('idOrSlug') idOrSlug: string) {
    return this.categoriesService.findByIdOrSlug(idOrSlug, true);
  }
}
