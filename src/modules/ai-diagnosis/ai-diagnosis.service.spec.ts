// src/modules/ai-diagnosis/ai-diagnosis.service.spec.ts
//
// These tests exist because the previous version of this module passed every
// plausible reading of the code and still did not work: it posted a field the
// AI Service has never accepted, read three fields it has never returned, and
// invented a diagnosis whenever the call failed. What follows pins the parts
// that were wrong, using a payload copied from a real reply.

import 'reflect-metadata';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { AiDiagnosisService } from './ai-diagnosis.service';

const REAL_REPLY = {
  requestId: null,
  sessionId: '3cbaa8d2db114169b06907d7d3e27161',
  status: 'ok',
  engine: 'local_pipeline',
  device: null,
  visibleConditions: [],
  suspectedFaults: [
    {
      faultCode: 'WM_BEARING_NOISE',
      nameVi: 'Mòn bạc đạn lồng giặt',
      confidence: 0.88,
      source: 'description',
    },
  ],
  recommendedServices: [
    { serviceCode: 'SUA_MAY_GIAT', nameVi: 'Sửa máy giặt rung lắc / không vắt' },
  ],
  suggestedActionsVi: ['Giảm tải mỗi mẻ giặt cho tới khi sửa'],
  priceEstimate: { min: 100000, max: null, currency: 'VND', requiresAssessment: true },
  urgency: 'MEDIUM',
  confidence: 0.88,
  isLowConfidence: false,
  clarification: null,
  messageVi: 'Em đã đọc và kiểm tra thông tin anh/chị gửi...',
  modelInfo: { vlm: 'Qwen/Qwen2.5-VL-3B-Instruct-AWQ' },
  disclaimerVi: 'Đây là gợi ý sơ bộ...',
};

describe('AiDiagnosisService', () => {
  let service: AiDiagnosisService;
  let http: any;
  let diagnosisRepo: any;
  let serviceRepo: any;

  beforeEach(() => {
    http = {
      post: vi.fn().mockReturnValue(of({ data: structuredClone(REAL_REPLY) })),
      get: vi.fn().mockReturnValue(of({ data: {} })),
    };
    diagnosisRepo = {
      create: vi.fn((row: unknown) => row),
      save: vi.fn().mockResolvedValue({ id: 'saved-uuid' }),
      findOneBy: vi.fn().mockResolvedValue(null),
    };
    serviceRepo = {
      find: vi
        .fn()
        .mockResolvedValue([
          { id: 'service-uuid-1', code: 'SUA_MAY_GIAT' },
          { id: 'service-uuid-2', code: 'KIEM_TRA_CHAN_DOAN_THIET_BI' },
        ]),
    };
    const config = { get: vi.fn().mockReturnValue('http://ai.test:8000') };

    service = new AiDiagnosisService(diagnosisRepo, serviceRepo, http, config as any);
  });

  const bodyOf = (call: number = 0) => http.post.mock.calls[call][1];

  describe('the request it sends', () => {
    it('posts images as an array, which is the only form the AI accepts', async () => {
      await service.analyze({ description: 'không vắt', images: ['data:image/jpeg;base64,AAA'] });

      expect(bodyOf().images).toEqual(['data:image/jpeg;base64,AAA']);
      expect(bodyOf()).not.toHaveProperty('imageUrl');
    });

    it('never sends more than three images, because the AI rejects the fourth', async () => {
      await service.analyze({ description: '', images: ['a', 'b', 'c', 'd', 'e'] });

      expect(bodyOf().images).toEqual(['a', 'b', 'c']);
    });

    it('forwards the session id, without which nothing is remembered', async () => {
      await service.analyze({ description: 'mới vệ sinh tháng trước', sessionId: 'abc123' });

      expect(bodyOf().sessionId).toBe('abc123');
    });

    it('sends an empty description when the customer only sent a photo', async () => {
      await service.analyze({ description: '', images: ['a'] });

      expect(bodyOf().description).toBe('');
    });

    it('does not double the slash when AI_SERVICE_URL has a trailing one', () => {
      const config = { get: vi.fn().mockReturnValue('http://ai.test:8000/') };
      const other = new AiDiagnosisService(diagnosisRepo, serviceRepo, http, config as any);

      return other.analyze({ description: 'x' }).then(() => {
        expect(http.post.mock.calls[0][0]).toBe('http://ai.test:8000/api/v1/diagnosis/analyze');
      });
    });
  });

  describe('the reply it returns', () => {
    it('passes the AI fields through unchanged rather than remapping them', async () => {
      const result = await service.analyze({ description: 'không vắt' });

      expect(result.suspectedFaults).toEqual(REAL_REPLY.suspectedFaults);
      expect(result.suggestedActionsVi).toEqual(REAL_REPLY.suggestedActionsVi);
      expect(result.messageVi).toBe(REAL_REPLY.messageVi);
      expect(result.urgency).toBe('MEDIUM');
      expect(result.sessionId).toBe(REAL_REPLY.sessionId);
    });

    it('keeps a null price ceiling null instead of inventing a maximum', async () => {
      const result = await service.analyze({ description: 'không vắt' });

      expect((result.priceEstimate as any).max).toBeNull();
      expect((result.priceEstimate as any).requiresAssessment).toBe(true);
    });

    it('resolves the catalogue code into the service id the app needs to book', async () => {
      const result = await service.analyze({ description: 'không vắt' });

      expect(result.recommendedServices).toEqual([
        {
          serviceCode: 'SUA_MAY_GIAT',
          nameVi: 'Sửa máy giặt rung lắc / không vắt',
          serviceId: 'service-uuid-1',
        },
      ]);
    });

    it('returns a null service id for an unknown code instead of failing the answer', async () => {
      http.post.mockReturnValue(
        of({
          data: {
            ...structuredClone(REAL_REPLY),
            recommendedServices: [{ serviceCode: 'NOT_IN_CATALOGUE', nameVi: 'Lạ' }],
          },
        }),
      );

      const result = await service.analyze({ description: 'không vắt' });

      expect((result.recommendedServices as any[])[0].serviceId).toBeNull();
    });

    it('reads the catalogue once and then serves it from cache', async () => {
      await service.analyze({ description: 'a' });
      await service.analyze({ description: 'b' });

      expect(serviceRepo.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the AI is not reachable', () => {
    beforeEach(() => {
      http.post.mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
    });

    it('does not throw, because AI failure must not block a booking', async () => {
      await expect(service.analyze({ description: 'không vắt' })).resolves.toBeDefined();
    });

    it('says so plainly and invents no fault, price or confidence', async () => {
      const result = await service.analyze({ description: 'điều hòa không mát' });

      expect(result.status).toBe('unavailable');
      expect(result.aiAvailable).toBe(false);
      expect(result.suspectedFaults).toEqual([]);
      expect(result.priceEstimate).toBeNull();
      expect(result.confidence).toBe(0);
      expect(String(result.messageVi)).toContain('không kết nối được');
    });

    it('mentions no appliance the customer never mentioned', async () => {
      const result = await service.analyze({ description: 'điều hòa không mát' });
      const text = String(result.messageVi) + String(result.answerVi);

      for (const invented of ['gas', 'R32', 'aptomat', 'bạc đạn', '450']) {
        expect(text).not.toContain(invented);
      }
    });

    it('writes nothing to the database', async () => {
      await service.analyze({ description: 'x', bookingId: '11111111-1111-1111-1111-111111111111' });

      expect(diagnosisRepo.save).not.toHaveBeenCalled();
    });

    it('keeps the disclaimer, which is required on every reply', async () => {
      const result = await service.analyze({ description: 'x' });

      expect(result.disclaimerVi).toBeTruthy();
    });
  });

  describe('what it stores', () => {
    it('stores nothing when there is no booking to attach it to', async () => {
      await service.analyze({ description: 'không vắt' });

      expect(diagnosisRepo.save).not.toHaveBeenCalled();
    });

    it('stores the diagnosis once a booking exists', async () => {
      await service.analyze({
        description: 'không vắt',
        bookingId: '11111111-1111-1111-1111-111111111111',
      });

      const row = diagnosisRepo.create.mock.calls[0][0];
      expect(row.bookingId).toBe('11111111-1111-1111-1111-111111111111');
      expect(row.suggestedServiceId).toBe('service-uuid-1');
      expect(row.rawResponse.faultCodes).toEqual(['WM_BEARING_NOISE']);
      expect(row.priceRangeMax).toBe(0);
    });

    it('still answers the customer when the write fails', async () => {
      diagnosisRepo.save.mockRejectedValue(new Error('db down'));

      const result = await service.analyze({
        description: 'không vắt',
        bookingId: '11111111-1111-1111-1111-111111111111',
      });

      expect(result.suspectedFaults).toEqual(REAL_REPLY.suspectedFaults);
    });
  });

  describe('ask', () => {
    it('posts the question to the chat route', async () => {
      http.post.mockReturnValue(
        of({ data: { sessionId: 's1', status: 'ok', answerVi: 'Bảo hành 30 ngày.' } }),
      );

      const result = await service.ask({ question: 'bảo hành bao lâu', sessionId: 's1' });

      expect(http.post.mock.calls[0][0]).toBe('http://ai.test:8000/api/v1/chat/ask');
      expect(bodyOf()).toMatchObject({ question: 'bảo hành bao lâu', sessionId: 's1' });
      expect(result.answerVi).toBe('Bảo hành 30 ngày.');
    });

    it('degrades to the honest message like analyze does', async () => {
      http.post.mockReturnValue(throwError(() => new Error('timeout')));

      const result = await service.ask({ question: 'bảo hành bao lâu' });

      expect(result.status).toBe('unavailable');
      expect(String(result.answerVi)).toContain('không kết nối được');
    });
  });

  describe('acknowledgements', () => {
    // The AI groups these by situation - the shape is {version, situations,
    // safetyFirst}, not a flat list. Reading it as a flat list is how the client
    // silently ended up on the local fallback while the AI was answering fine.
    const AI_SHAPE = {
      version: '2026-09-16',
      situations: {
        first_text: ['Dạ em nhận được thông tin rồi ạ...'],
        first_photo: ['Dạ em nhận được ảnh rồi ạ...'],
        price_question: ['Dạ vâng, để em tra bảng giá ngay ạ.'],
      },
    };

    it('passes the situation groups through untouched', async () => {
      http.get.mockReturnValue(of({ data: AI_SHAPE }));

      const result = await service.getAcknowledgements();

      expect(result).toEqual(AI_SHAPE);
    });

    it('serves the cached copy on the second call', async () => {
      http.get.mockReturnValue(of({ data: AI_SHAPE }));
      await service.getAcknowledgements();
      await service.getAcknowledgements();

      expect(http.get).toHaveBeenCalledTimes(1);
    });

    it('falls back to local lines rather than leaving the client silent', async () => {
      http.get.mockReturnValue(throwError(() => new Error('down')));

      const result = await service.getAcknowledgements();
      const situations = result.situations as Record<string, string[]>;

      expect(Object.keys(situations).length).toBeGreaterThan(0);
      expect(situations.first_photo.length).toBeGreaterThan(0);
    });

    it('ignores a reply that is missing the situations map', async () => {
      http.get.mockReturnValue(of({ data: { acknowledgementsVi: ['wrong shape'] } }));

      const result = await service.getAcknowledgements();

      expect(result.version).toBe('local-fallback');
    });
  });

  describe('health', () => {
    it('is available only when both models are attached', async () => {
      http.get.mockReturnValue(
        of({ data: { vlm: { attached: true }, detector: { attached: true }, knowledge: { chunks: 3319 } } }),
      );

      await expect(service.checkAiServiceHealth()).resolves.toMatchObject({
        status: 'connected',
        available: true,
      });
    });

    it('reports loading while the box answers but the models are not up yet', async () => {
      http.get.mockReturnValue(of({ data: { vlm: { attached: false }, detector: { attached: true } } }));

      await expect(service.checkAiServiceHealth()).resolves.toMatchObject({
        status: 'loading',
        available: false,
      });
    });
  });
});
