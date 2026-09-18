import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout } from 'rxjs';
import { PlaceLocationDto, PlaceSuggestionDto } from './dto/geo.dto';

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
   * Forward geocoding – returns place suggestions for a partial text input.
   * MapTiler response is GeoJSON FeatureCollection.
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
      const features = Array.isArray(response.data?.features) ? response.data.features : [];
      return features.map((f: { id: string; place_name: string }) => ({
        placeId: f.id,
        description: f.place_name,
      }));
    } catch (error) {
      this.logger.warn(`MapTiler autocomplete failed: ${(error as Error)?.name || 'unknown'}`);
      throw new ServiceUnavailableException('Address lookup is temporarily unavailable');
    }
  }

  /**
   * Resolve a MapTiler feature id back to coordinates + formatted address.
   * MapTiler does not have a separate "place detail" endpoint, so we
   * re-query forward geocoding with the full place_name stored in placeId
   * (which is the feature id like "municipality.46425").
   *
   * Because the frontend flow is: autocomplete → pick → geocode(placeId),
   * and MapTiler autocomplete already returns coordinates, the controller
   * could also be adjusted to return coords directly from autocomplete.
   * For now we keep the same interface and re-query using the id.
   */
  async placeDetail(placeId: string): Promise<PlaceLocationDto> {
    try {
      const response = await firstValueFrom(
        this.httpService
          .get(`${this.baseUrl}/${encodeURIComponent(placeId)}.json`, {
            params: {
              key: this.apiKey,
              language: 'vi',
              country: 'vn',
              limit: 1,
            },
          })
          .pipe(timeout(this.requestTimeoutMs)),
      );
      const feature = Array.isArray(response.data?.features) ? response.data.features[0] : null;
      if (!feature?.center || feature.center.length < 2) {
        throw new Error('No geometry in MapTiler response');
      }
      return {
        lat: feature.center[1],
        lng: feature.center[0],
        formattedAddress: feature.place_name || '',
      };
    } catch (error) {
      this.logger.warn(`MapTiler place detail failed: ${(error as Error)?.name || 'unknown'}`);
      throw new ServiceUnavailableException('Address lookup is temporarily unavailable');
    }
  }

  /**
   * Reverse geocode coordinates → formatted address.
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
      const feature = Array.isArray(response.data?.features) ? response.data.features[0] : null;
      if (!feature?.center || feature.center.length < 2) {
        throw new Error('No geometry in MapTiler response');
      }
      return {
        lat: feature.center[1],
        lng: feature.center[0],
        formattedAddress: feature.place_name || '',
      };
    } catch (error) {
      this.logger.warn(`MapTiler reverse geocode failed: ${(error as Error)?.name || 'unknown'}`);
      throw new ServiceUnavailableException('Address lookup is temporarily unavailable');
    }
  }
}
