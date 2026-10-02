import { describe, expect, it } from 'vitest';
import { AI_SUMMARY_LIMITS, emptySummary, hasAdvice, mergeTurn, toBookingSummary } from './ai-chat-summary';

const diagnosis = {
  status: 'ok',
  sessionId: 's1',
  device: { deviceType: 'air_conditioner', nameVi: 'Máy lạnh' },
  suspectedFaults: [{ faultCode: 'A', nameVi: 'Máy chạy ồn, rung lắc' }, { faultCode: 'B', nameVi: 'Hỏng mô tơ quạt dàn lạnh' }],
  suggestedActionsVi: ['Tắt máy', 'Kiểm tra vật lạ'],
  recommendedServices: [{ serviceCode: 'SUA_DIEU_HOA', nameVi: 'Sửa điều hòa' }],
  priceEstimate: { min: 100000, max: 1210000, currency: 'VND', requiresAssessment: true },
  messageVi: 'Có thể quạt dàn lạnh bị kẹt.',
};

describe('AI chat summary', () => {
  it('keeps what the assistant found and the customer said', () => {
    const s = mergeTurn(emptySummary(), { text: 'Máy lạnh kêu lạch cạch', photoCount: 2 }, diagnosis);
    expect(s).toMatchObject({
      deviceName: 'Máy lạnh',
      customerText: 'Máy lạnh kêu lạch cạch',
      suspectedFaults: ['Máy chạy ồn, rung lắc', 'Hỏng mô tơ quạt dàn lạnh'],
      suggestedActions: ['Tắt máy', 'Kiểm tra vật lạ'],
      priceMin: 100000,
      priceMax: 1210000,
      requiresAssessment: true,
      recommendedServiceName: 'Sửa điều hòa',
      photoCount: 2,
      turnCount: 1,
      conclusion: 'Có thể quạt dàn lạnh bị kẹt.',
    });
    expect(hasAdvice(s)).toBe(true);
  });

  it('does not let a later empty or unavailable reply erase earlier findings', () => {
    const first = mergeTurn(emptySummary(), { text: 'kêu to' }, diagnosis);
    const unavailable = mergeTurn(first, { text: 'còn đó không?' }, { status: 'unavailable', messageVi: 'Trợ lý đang bận' });
    expect(unavailable.suspectedFaults).toEqual(first.suspectedFaults);
    expect(unavailable.conclusion).toBe(first.conclusion);
    expect(unavailable.priceMin).toBe(100000);
    expect(unavailable.turnCount).toBe(2);

    const plainAnswer = mergeTurn(unavailable, { text: 'bảo hành bao lâu?' }, { status: 'ok', answerVi: 'Tùy kỹ thuật viên.', priceEstimate: null });
    expect(plainAnswer.conclusion).toBe(first.conclusion);
    expect(plainAnswer.priceMax).toBe(1210000);
  });

  it('takes a plain answer as the conclusion only until a diagnosis arrives', () => {
    const ask = mergeTurn(emptySummary(), { text: 'máy lạnh không mát' }, { status: 'ok', answerVi: 'Có thể thiếu gas.' });
    expect(ask.conclusion).toBe('Có thể thiếu gas.');
    const diag = mergeTurn(ask, { text: 'ảnh đây' }, diagnosis);
    expect(diag.conclusion).toBe('Có thể quạt dàn lạnh bị kẹt.');
  });

  it('ignores impossible prices and a max below the min', () => {
    const s = mergeTurn(emptySummary(), {}, { status: 'ok', priceEstimate: { min: 500000, max: 100, requiresAssessment: false } });
    expect(s.priceMin).toBe(500000);
    expect(s.priceMax).toBeNull();
    const negative = mergeTurn(emptySummary(), {}, { status: 'ok', priceEstimate: { min: -5, max: 10 } });
    expect(negative.priceMin).toBeNull();
  });

  it('bounds long, emoji-heavy and odd input', () => {
    const huge = '🔥❄️ máy lạnh ' + 'ồn '.repeat(2000) + '\u0000‮';
    let s = mergeTurn(emptySummary(), { text: huge, photoCount: 999 }, { ...diagnosis, messageVi: 'x'.repeat(5000), suspectedFaults: Array(10).fill({ nameVi: '😀'.repeat(500) }) });
    expect(s.customerText!.length).toBeLessThanOrEqual(AI_SUMMARY_LIMITS.customerText);
    expect(s.conclusion!.length).toBeLessThanOrEqual(AI_SUMMARY_LIMITS.conclusion);
    expect(s.suspectedFaults).toHaveLength(AI_SUMMARY_LIMITS.items);
    expect(s.suspectedFaults[0].length).toBeLessThanOrEqual(AI_SUMMARY_LIMITS.item);
    expect(s.photoCount).toBe(10);
    for (let i = 0; i < 20; i++) s = mergeTurn(s, { text: `lượt ${i} ` + 'a'.repeat(300) }, { status: 'ok' });
    expect(s.customerText!.length).toBeLessThanOrEqual(AI_SUMMARY_LIMITS.customerText);
    expect(s.customerText).toContain('lượt 19');
  });

  it('treats non-string fields from the AI as absent', () => {
    const s = mergeTurn(emptySummary(), { text: 42 as unknown as string }, { status: 'ok', device: { nameVi: { evil: true } }, suspectedFaults: 'nope', messageVi: ['x'] });
    expect(s.deviceName).toBeNull();
    expect(s.suspectedFaults).toEqual([]);
    expect(s.conclusion).toBeNull();
    expect(hasAdvice(s)).toBe(false);
  });

  it('freezes a booking copy without the turn counter', () => {
    const copy = toBookingSummary(mergeTurn(emptySummary(), { text: 'a' }, diagnosis), new Date('2026-10-01T00:00:00Z'));
    expect(copy).not.toHaveProperty('turnCount');
    expect(copy.recordedAt).toBe('2026-10-01T00:00:00.000Z');
  });
});
