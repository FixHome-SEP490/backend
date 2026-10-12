import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout } from 'rxjs';
import { PlaceLocationDto, PlaceSuggestionDto } from './dto/geo.dto';

interface MapTilerContextEntry {
  id: string;
  text: string;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    osm_type?: string;
    osm_id?: number;
    name?: string;
    housenumber?: string;
    street?: string;
    locality?: string;
    district?: string;
    county?: string;
    city?: string;
    state?: string;
    countrycode?: string;
  };
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
  private readonly photonUrl = 'https://photon.komoot.io/api/';
  /** TP Hồ Chí Minh: most bookings are there, so it is the default "look here first". */
  private readonly defaultNear = { lat: 10.7769, lng: 106.7009 };

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
   * Suggestions for a typed address or place name (PO 12/10/2026: "nhà văn hóa sinh viên" gave only
   * other provinces). MapTiler knows streets but almost no Vietnamese places, so OpenStreetMap through
   * Photon is asked first, nearest to `near` (TP HCM by default); MapTiler answers when Photon fails
   * or finds nothing in Vietnam. OSM still names some areas by the pre-2025 provinces.
   */
  async autocomplete(input: string, near?: { lat: number; lng: number }): Promise<PlaceSuggestionDto[]> {
    const point = near ?? this.defaultNear;
    // Both are asked at once. A house number in front ("12 Lê Lợi") is a street address, where
    // MapTiler is better and already uses the post-2025 ward names; a name is a place, where only
    // OpenStreetMap has data. The better source leads, the other fills the list up to 6.
    const [osm, maptiler] = await Promise.all([
      this.photonSearch(input, point).catch((error: unknown) => {
        this.logger.warn(`Photon autocomplete failed: ${(error as Error)?.name || 'unknown'}`);
        return null;
      }),
      this.maptilerSearch(input, point).catch(() => null),
    ]);
    if (!osm && !maptiler) throw new ServiceUnavailableException('Address lookup is temporarily unavailable');
    const streetAddress = /^\s*\d+[\w/-]*\s/.test(input);
    const ordered = streetAddress ? [...(maptiler ?? []), ...(osm ?? [])] : [...(osm ?? []), ...(maptiler ?? [])];
    const seen = new Set<string>();
    return ordered
      .filter((s) => {
        // Same place from both sources: same name and within ~100 m.
        const key = `${s.description.split(',')[0].trim().toLowerCase()}@${s.lat.toFixed(3)},${s.lng.toFixed(3)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 6);
  }

  private async photonSearch(input: string, near: { lat: number; lng: number }): Promise<PlaceSuggestionDto[]> {
    const response = await firstValueFrom(
      this.httpService
        .get(this.photonUrl, {
          params: { q: input, lat: near.lat, lon: near.lng, limit: 10, lang: 'default' },
          headers: { 'User-Agent': 'FixHome/1.0 (SEP490 student project)' },
        })
        .pipe(timeout(this.requestTimeoutMs)),
    );
    const features: PhotonFeature[] = Array.isArray(response.data?.features) ? response.data.features : [];
    const seen = new Set<string>();
    return features
      .filter((f) => f.properties?.countrycode === 'VN' && Array.isArray(f.geometry?.coordinates) && f.geometry!.coordinates!.length >= 2)
      .map((f) => this.mapPhoton(f))
      .filter((s) => !seen.has(s.description) && seen.add(s.description))
      .slice(0, 6);
  }

  private mapPhoton(f: PhotonFeature): PlaceSuggestionDto {
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry!.coordinates!;
    const street = [p.housenumber, p.street].filter(Boolean).join(' ');
    const parts = [p.name, street, p.locality, p.district, p.county, p.city, p.state].filter((x): x is string => !!x);
    return {
      placeId: `osm:${p.osm_type ?? ''}${p.osm_id ?? `${lat},${lng}`}`,
      description: parts.filter((x, i) => parts.indexOf(x) === i).join(', '),
      lat,
      lng,
      ward: p.district || p.locality,
      district: p.county || (p.state ? p.city : undefined),
      province: p.state || p.city,
    };
  }

  private async maptilerSearch(input: string, near?: { lat: number; lng: number }): Promise<PlaceSuggestionDto[]> {
    try {
      const response = await firstValueFrom(
        this.httpService
          .get(`${this.baseUrl}/${encodeURIComponent(input)}.json`, {
            params: {
              key: this.apiKey,
              language: 'vi',
              country: 'vn',
              limit: 5,
              ...(near ? { proximity: `${near.lng},${near.lat}` } : {}),
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

  /** Keyed by depth: a depth-1 list (no districts) must never answer a depth-2 request. */
  private readonly provincesCache = new Map<number, any[]>();

  async getProvinces(depth = 2): Promise<any[]> {
    const cached = this.provincesCache.get(depth);
    if (cached && cached.length > 0) {
      return cached;
    }
    try {
      const response = await firstValueFrom(
        this.httpService.get(`https://provinces.open-api.vn/api/v1/?depth=${depth}`, {
          timeout: 10000,
        }),
      );
      if (Array.isArray(response.data)) this.provincesCache.set(depth, response.data);
      return response.data;
    } catch (error) {
      this.logger.warn(`Failed to fetch provinces from open-api.vn: ${(error as Error)?.message}`);
      return [];
    }
  }
}

