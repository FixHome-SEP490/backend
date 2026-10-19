// src/modules/services/services.controller.ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ServicesService } from './services.service';
import { QueryServicesDto, ServiceResponseDto } from './dto';
import { CatalogV2PricingQueryDto } from './dto/catalog-v2-pricing-query.dto';

@ApiTags('Services')
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get(':id/catalog-v2-pricing')
  @ApiOperation({ summary: 'Public: Preview an active Catalog V2 service using approved scopes and device facts', description: 'Advisory only. Booking revalidates active DB tiers before binding. Missing facts produce inspection with NULL fixed S.' })
  @ApiOkResponse({ description: 'Approved applicable variants, selected tier, NONBINDING range and inspection reason. No customer data.' })
  @ApiBadRequestResponse({ description: 'Invalid facts or mismatched variant selection' })
  @ApiNotFoundResponse({ description: 'Service inactive, gated or outside Catalog V2' })
  async catalogV2Pricing(@Param('id') id: string, @Query() query: CatalogV2PricingQueryDto) {
    return this.servicesService.catalogV2Pricing(id, query);
  }

  @Get()
  @ApiOperation({
    summary: 'Public: Browse services catalog with pagination and filters',
  })
  @ApiOkResponse({
    description: 'Services list fetched successfully',
    type: ServiceResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid pagination or service filters' })
  async findServices(@Query() query: QueryServicesDto) {
    query.isActive = true;
    return this.servicesService.findServices(query, true);
  }

  @Get(':idOrSlug')
  @ApiOperation({ summary: 'Public: Get service detail by ID or slug' })
  @ApiOkResponse({
    description: 'Service detail fetched successfully',
    type: ServiceResponseDto,
  })
  @ApiNotFoundResponse({ description: 'Service not found' })
  async findByIdOrSlug(@Param('idOrSlug') idOrSlug: string) {
    return this.servicesService.findByIdOrSlug(idOrSlug, true);
  }
}
