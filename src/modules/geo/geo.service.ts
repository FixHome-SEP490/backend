import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout } from 'rxjs';
import { PlaceLocationDto, PlaceSuggestionDto } from './dto/geo.dto';

interface MapTilerContextEntry {
  id: string;
  text: string;
}

interface MapTilerFeature {
  id: string;
  place_name: string;
  center: [number, number];
  context?: MapTilerContextEntry[];
}

/**
 * Thin proxy over MapTiler Geocoding REST API (forward / reverse geocode).
 * Keeps MAPTILER_API_KEY server-side; clients only get suggestions/coordinates.
 *
 * @see https://docs.maptiler.com/cloud/api/geocoding/
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);
  private readonly baseUrl = 'https://api.maptiler.com/geocoding';
  private readonly requestTimeoutMs = 8000;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {}

  private get apiKey(): string {
    const key = this.configService.get<string>('MAPTILER_API_KEY');
    if (!key) throw new ServiceUnavailableException('Map service is not configured');
    return key;
  }

  /**
   * Pulls ward/district/province out of MapTiler's `context` array. Vietnam's admin
   * structure varies by area (some places still have a district level, many post-reform
   * areas go straight from ward to province), so every field here is best-effort.
   */
  private extractAdminArea(context: MapTilerContextEntry[] = []): { ward?: string; district?: string; province?: string } {
    const find = (prefix: string) => context.find((c) => c.id?.startsWith(prefix))?.text;
    return {
      ward: find('municipality.') || find('locality.'),
      district: find('county.') || find('subregion.'),
      province: find('region.'),
    };
  }

  private mapSuggestion = (f: MapTilerFeature): PlaceSuggestionDto => ({
    placeId: f.id,
    description: f.place_name,
    lat: f.center[1],
    lng: f.center[0],
    ...this.extractAdminArea(f.context),
  });

  private mapLocation = (f: MapTilerFeature): PlaceLocationDto => ({
    lat: f.center[1],
    lng: f.center[0],
    formattedAddress: f.place_name || '',
    ...this.extractAdminArea(f.context),
  });

  /**
   * Forward geocoding – returns place suggestions for a partial text input.
   * MapTiler response is a GeoJSON FeatureCollection; each feature already carries
   * coordinates + admin-area context, so the frontend never needs a follow-up lookup.
   */
  async autocomplete(input: string): Promise<PlaceSuggestionDto[]> {
    try {
      const response = await firstValueFrom(
        this.httpService
          .get(`${this.baseUrl}/${encodeURIComponent(input)}.json`, {
            params: {
              key: this.apiKey,
              language: 'vi',
              country: 'vn',
              limit: 5,
            },
          })
          .pipe(timeout(this.requestTimeoutMs)),
      );
      const features: MapTilerFeature[] = Array.isArray(response.data?.features) ? response.data.features : [];
      return features.filter((f) => Array.isArray(f.center) && f.center.length >= 2).map(this.mapSuggestion);
    } catch (error) {
      this.logger.warn(`MapTiler autocomplete failed: ${(error as Error)?.name || 'unknown'}`);
      throw new ServiceUnavailableException('Address lookup is temporarily unavailable');
    }
  }

  /**
   * Reverse geocode coordinates → formatted address + admin area.
   * MapTiler format: GET /geocoding/{lng},{lat}.json?key=...
   */
  async reverseGeocode(lat: number, lng: number): Promise<PlaceLocationDto> {
    try {
      const response = await firstValueFrom(
        this.httpService
          .get(`${this.baseUrl}/${lng},${lat}.json`, {
            params: {
              key: this.apiKey,
              language: 'vi',
            },
          })
          .pipe(timeout(this.requestTimeoutMs)),
      );
      const feature: MapTilerFeature | null = Array.isArray(response.data?.features) ? response.data.features[0] : null;
      if (!feature?.center || feature.center.length < 2) {
        throw new Error('No geometry in MapTiler response');
      }
      return this.mapLocation(feature);
    } catch (error) {
      this.logger.warn(`MapTiler reverse geocode failed: ${(error as Error)?.name || 'unknown'}`);
      throw new ServiceUnavailableException('Address lookup is temporarily unavailable');
    }
  }
}
