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
    const nhaVanHoa = {
      geometry: { coordinates: [106.7822, 10.8795] },
      properties: { osm_type: 'W', osm_id: 42, name: 'Nhà Văn Hóa Sinh Viên', street: 'Quảng Trường Sáng Tạo', district: 'Đông Hòa', state: 'Bình Dương', countrycode: 'VN' },
    };
    const leLoi = { id: 'address.1', place_name: 'Lê Lợi, 70000 Phường Sài Gòn, Việt Nam', center: [106.7005, 10.7745], context: [{ id: 'municipality.1', text: 'Phường Sài Gòn' }, { id: 'region.1', text: 'Thành phố Hồ Chí Minh' }] };
    /** Answers by URL: both sources are asked at once. */
    const sources = (osm: unknown, maptiler: unknown) =>
      mockHttpService.get.mockImplementation((url: string) => {
        const answer = url.includes('photon') ? osm : maptiler;
        return answer instanceof Error ? throwError(() => answer) : of({ data: { features: answer } });
      });

    it('puts OpenStreetMap places first for a name, near TP HCM by default, Vietnam only (PO 12/10/2026)', async () => {
      const abroad = { geometry: { coordinates: [100.5, 13.7] }, properties: { osm_type: 'N', osm_id: 7, name: 'Nhà văn hóa', countrycode: 'TH' } };
      sources([nhaVanHoa, abroad, nhaVanHoa], [leLoi]);

      const res = await service.autocomplete('nhà văn hóa sinh viên');

      const photonCall = mockHttpService.get.mock.calls.find(([url]: [string]) => url.includes('photon'));
      expect(photonCall[1].params).toMatchObject({ q: 'nhà văn hóa sinh viên', lat: 10.7769, lon: 106.7009 });
      const maptilerCall = mockHttpService.get.mock.calls.find(([url]: [string]) => url.includes('maptiler'));
      expect(maptilerCall[1].params).toMatchObject({ proximity: '106.7009,10.7769', country: 'vn' });
      expect(res[0]).toEqual({
        placeId: 'osm:W42',
        description: 'Nhà Văn Hóa Sinh Viên, Quảng Trường Sáng Tạo, Đông Hòa, Bình Dương',
        lat: 10.8795,
        lng: 106.7822,
        ward: 'Đông Hòa',
        district: undefined,
        province: 'Bình Dương',
      });
      expect(res.map((r) => r.placeId)).toEqual(['osm:W42', 'address.1']);
    });

    it('puts MapTiler first for a street address with a house number', async () => {
      sources([nhaVanHoa], [leLoi]);

      const res = await service.autocomplete('12 Lê Lợi Quận 1');

      expect(res.map((r) => r.placeId)).toEqual(['address.1', 'osm:W42']);
      expect(res[0]).toMatchObject({ ward: 'Phường Sài Gòn', province: 'Thành phố Hồ Chí Minh' });
    });

    it('looks near the given position in both sources', async () => {
      sources([nhaVanHoa], []);

      await service.autocomplete('nhà văn hóa', { lat: 21.03, lng: 105.85 });

      const calls = mockHttpService.get.mock.calls as Array<[string, { params: Record<string, unknown> }]>;
      expect(calls.find(([url]) => url.includes('photon'))![1].params).toMatchObject({ lat: 21.03, lon: 105.85 });
      expect(calls.find(([url]) => url.includes('maptiler'))![1].params).toMatchObject({ proximity: '105.85,21.03' });
    });

    it('drops the same place found by both, and keeps at most six', async () => {
      const samePlace = { id: 'poi.9', place_name: 'Nhà Văn Hóa Sinh Viên, Đông Hòa', center: [106.78221, 10.87951] };
      const many = Array.from({ length: 8 }, (_, k) => ({ id: `address.${k}`, place_name: `Đường ${k}`, center: [106.7 + k / 100, 10.77] }));
      sources([nhaVanHoa], [samePlace, ...many]);

      const res = await service.autocomplete('nhà văn hóa sinh viên');

      expect(res).toHaveLength(6);
      expect(res.filter((r) => /Nhà Văn Hóa Sinh Viên/.test(r.description))).toHaveLength(1);
    });

    it('answers from the other source when one fails', async () => {
      sources(new Error('Photon down'), [leLoi]);
      expect((await service.autocomplete('Lê Lợi')).map((r) => r.placeId)).toEqual(['address.1']);

      mockHttpService.get.mockReset();
      sources([nhaVanHoa], new Error('MapTiler down'));
      expect((await service.autocomplete('nhà văn hóa')).map((r) => r.placeId)).toEqual(['osm:W42']);
    });

    it('should map MapTiler context to ward, district and province', async () => {
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
      sources([], [feature]);

      const res = await service.autocomplete('123 Nguyễn Thị Minh Khai');
      expect(res).toHaveLength(1);
      expect(res[0].description).toBe(feature.place_name);
      expect(res[0].lat).toBe(10.7756);
      expect(res[0].lng).toBe(106.7019);
      expect(res[0].district).toBe('Quận 1');
      expect(res[0].province).toBe('Thành phố Hồ Chí Minh');
    });

    it('should throw ServiceUnavailableException when Photon and MapTiler both fail', async () => {
      sources(new Error('Photon down'), new Error('API timeout'));

      await expect(service.autocomplete('query')).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
