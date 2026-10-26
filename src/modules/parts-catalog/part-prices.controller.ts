// src/modules/parts-catalog/part-prices.controller.ts
import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PartsCatalogService } from './parts-catalog.service';

/**
 * Public, like GET /services: the AI Service reads it without a login to
 * price "service + parts" estimates, and refreshes it every few minutes.
 */
@ApiTags('Parts Catalog')
@Controller('parts/prices')
export class PartPricesController {
  constructor(private readonly partsCatalogService: PartsCatalogService) {}

  @Get()
  @ApiOperation({
    summary: 'Public: selling price of each active FixHome part (sku, name, price)',
    description: 'For the AI price estimate. Active parts with a SKU only; cached for five minutes.',
  })
  @ApiOkResponse({ description: '{ items: [{ sku, name, price }] }, price in VND' })
  async prices() {
    return { items: await this.partsCatalogService.publicPrices() };
  }
}
