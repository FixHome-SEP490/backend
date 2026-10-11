// src/modules/geo/geo.service.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GeoService } from './geo.service';
import { of, throwError } from 'rxjs';
import { ServiceUnavailableException } from '@nestjs/common';

describe('GeoService', () => {
  let service: GeoService;
  let mockHttpService: any;
  let mockConfigService: any;

  beforeEach(() => {
    mockHttpService = {
      get: vi.fn(),
    };
    mockConfigService = {
      get: vi.fn((key: string, defaultValue?: any) => {
        if (key === 'MAPTILER_API_KEY') return 'test-key';
        if (key === 'MAPTILER_TIMEOUT_MS') return 5000;
        return defaultValue;
      }),
    };

    service = new GeoService(mockHttpService, mockConfigService);
  });

  describe('getProvinces', () => {
    it('should fetch provinces and cache subsequent calls', async () => {
      const mockProvinces = [
        { code: 79, name: 'Thành phố Hồ Chí Minh' },
        { code: 1, name: 'Thành phố Hà Nội' },
      ];

      mockHttpService.get.mockReturnValueOnce(of({ data: mockProvinces }));

      const result1 = await service.getProvinces(2);
      expect(result1).toEqual(mockProvinces);
      expect(mockHttpService.get).toHaveBeenCalledTimes(1);

      // Call again should return from memory cache without new HTTP request
      const result2 = await service.getProvinces(2);
      expect(result2).toEqual(mockProvinces);
      expect(mockHttpService.get).toHaveBeenCalledTimes(1);
    });

    it('should fallback to empty array or existing cache on error', async () => {
      mockHttpService.get.mockReturnValueOnce(throwError(() => new Error('Network error')));

      const result = await service.getProvinces(2);
      expect(result).toEqual([]);
    });
  });

  describe('autocomplete', () => {
    const photon = (features: unknown[]) => of({ data: { features } });
    const nhaVanHoa = {
      geometry: { coordinates: [106.7822, 10.8795] },
      properties: { osm_type: 'W', osm_id: 42, name: 'Nhà Văn Hóa Sinh Viên', street: 'Quảng Trường Sáng Tạo', district: 'Đông Hòa', state: 'Bình Dương', countrycode: 'VN' },
    };

    it('asks OpenStreetMap (Photon) first, near TP HCM by default, and keeps Vietnam only (PO 12/10/2026)', async () => {
      const abroad = { geometry: { coordinates: [100.5, 13.7] }, properties: { osm_type: 'N', osm_id: 7, name: 'Nhà văn hóa', countrycode: 'TH' } };
      mockHttpService.get.mockReturnValueOnce(photon([nhaVanHoa, abroad, nhaVanHoa]));

      const res = await service.autocomplete('nhà văn hóa sinh viên');

      const [url, options] = mockHttpService.get.mock.calls[0];
      expect(url).toContain('photon.komoot.io');
      expect(options.params).toMatchObject({ q: 'nhà văn hóa sinh viên', lat: 10.7769, lon: 106.7009 });
      expect(res).toEqual([{
        placeId: 'osm:W42',
        description: 'Nhà Văn Hóa Sinh Viên, Quảng Trường Sáng Tạo, Đông Hòa, Bình Dương',
        lat: 10.8795,
        lng: 106.7822,
        ward: 'Đông Hòa',
        district: undefined,
        province: 'Bình Dương',
      }]);
      expect(mockHttpService.get).toHaveBeenCalledTimes(1);
    });

    it('looks near the given position when the caller sends one', async () => {
      mockHttpService.get.mockReturnValueOnce(photon([nhaVanHoa]));

      await service.autocomplete('nhà văn hóa', { lat: 21.03, lng: 105.85 });

      expect(mockHttpService.get.mock.calls[0][1].params).toMatchObject({ lat: 21.03, lon: 105.85 });
    });

    it('falls back to MapTiler, near the same position, when Photon finds nothing in Vietnam', async () => {
      mockHttpService.get.mockReturnValueOnce(photon([])).mockReturnValueOnce(of({ data: { features: [{ id: 'address.1', place_name: '1 Lê Lợi, Quận 1', center: [106.7, 10.77] }] } }));

      const res = await service.autocomplete('1 Lê Lợi', { lat: 10.8, lng: 106.6 });

      expect(res.map((r) => r.description)).toEqual(['1 Lê Lợi, Quận 1']);
      expect(mockHttpService.get.mock.calls[1][1].params).toMatchObject({ proximity: '106.6,10.8', country: 'vn' });
    });

    it('should map MapTiler features to PlaceSuggestionDto list', async () => {
      const feature = {
        id: 'place.123',
        place_name: '123 Nguyễn Thị Minh Khai, Phường Bến Thành, Quận 1, TP. Hồ Chí Minh',
        center: [106.7019, 10.7756],
        context: [
          { id: 'municipality.1', text: 'Bến Thành' },
          { id: 'county.1', text: 'Quận 1' },
          { id: 'region.1', text: 'Thành phố Hồ Chí Minh' },
        ],
      };

      // Photon unreachable: MapTiler answers.
      mockHttpService.get.mockReturnValueOnce(throwError(() => new Error('Photon down'))).mockReturnValueOnce(of({ data: { features: [feature] } }));

      const res = await service.autocomplete('123 Nguyễn Thị Minh Khai');
      expect(res).toHaveLength(1);
      expect(res[0].description).toBe(feature.place_name);
      expect(res[0].lat).toBe(10.7756);
      expect(res[0].lng).toBe(106.7019);
      expect(res[0].district).toBe('Quận 1');
      expect(res[0].province).toBe('Thành phố Hồ Chí Minh');
    });

    it('should throw ServiceUnavailableException when Photon and MapTiler both fail', async () => {
      mockHttpService.get.mockReturnValueOnce(throwError(() => new Error('Photon down'))).mockReturnValueOnce(throwError(() => new Error('API timeout')));

      await expect(service.autocomplete('query')).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
