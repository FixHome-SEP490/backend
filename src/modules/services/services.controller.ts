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

@ApiTags('Services')
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

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
