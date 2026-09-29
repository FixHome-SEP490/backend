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

      mockHttpService.get.mockReturnValueOnce(of({ data: { features: [feature] } }));

      const res = await service.autocomplete('123 Nguyễn Thị Minh Khai');
      expect(res).toHaveLength(1);
      expect(res[0].description).toBe(feature.place_name);
      expect(res[0].lat).toBe(10.7756);
      expect(res[0].lng).toBe(106.7019);
      expect(res[0].district).toBe('Quận 1');
      expect(res[0].province).toBe('Thành phố Hồ Chí Minh');
    });

    it('should throw ServiceUnavailableException when MapTiler fails', async () => {
      mockHttpService.get.mockReturnValueOnce(throwError(() => new Error('API timeout')));

      await expect(service.autocomplete('query')).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
