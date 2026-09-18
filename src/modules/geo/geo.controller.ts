import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GeoService } from './geo.service';
import { AutocompleteQueryDto, ReverseGeocodeQueryDto } from './dto/geo.dto';

@ApiTags('Geo')
@Controller('geo')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class GeoController {
  constructor(private readonly geoService: GeoService) {}

  @Get('autocomplete')
  @ApiOperation({ summary: 'Address suggestions for a partial input (MapTiler Geocoding)' })
  async autocomplete(@Query() query: AutocompleteQueryDto) {
    const data = await this.geoService.autocomplete(query.input);
    return { data };
  }

  @Get('reverse')
  @ApiOperation({ summary: 'Reverse geocode coordinates to a formatted address' })
  async reverse(@Query() query: ReverseGeocodeQueryDto) {
    const data = await this.geoService.reverseGeocode(query.lat, query.lng);
    return { data };
  }
}
