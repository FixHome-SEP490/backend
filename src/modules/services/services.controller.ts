// src/modules/services/services.controller.ts
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ServicesService } from './services.service';
import { QueryServicesDto } from './dto';

@ApiTags('Services')
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Get()
  @ApiOperation({
    summary: 'Public: Browse services catalog with pagination and filters',
  })
  @ApiResponse({
    status: 200,
    description: 'Services list fetched successfully',
  })
  async findServices(@Query() query: QueryServicesDto) {
    query.isActive = true;
    return this.servicesService.findServices(query, true);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Public: Get service detail by ID' })
  @ApiResponse({
    status: 200,
    description: 'Service detail fetched successfully',
  })
  @ApiResponse({ status: 404, description: 'Service not found' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.servicesService.findActiveById(id);
  }
}
