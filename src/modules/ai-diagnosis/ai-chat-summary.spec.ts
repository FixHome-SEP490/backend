import { describe, expect, it } from 'vitest';
import { AI_FEEDBACK_LIMITS, AI_HISTORY_LIMITS, AI_SUMMARY_LIMITS, addFeedback, emptySummary, hasAdvice, historyFromSummary, mergeTurn, toBookingSummary, vnDaysWindowStart } from './ai-chat-summary';

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

describe('historyFromSummary', () => {
  it('splits the recorded customer text back into turns, oldest first', () => {
    expect(historyFromSummary({ customerText: 'máy lạnh không mát / mới vệ sinh rồi' })).toEqual([
      'máy lạnh không mát',
      'mới vệ sinh rồi',
    ]);
  });

  it('drops the ellipsis left where older turns were cut, and empty pieces', () => {
    expect(historyFromSummary({ customerText: '…n rồi /  / còn kêu to' })).toEqual(['n rồi', 'còn kêu to']);
  });

  it('is empty for no summary', () => {
    expect(historyFromSummary(null)).toEqual([]);
    expect(historyFromSummary({ customerText: null })).toEqual([]);
  });

  it('stays within what the AI Service accepts', () => {
    const many = Array.from({ length: 30 }, (_, i) => `lượt ${i}`).join(' / ');
    const turns = historyFromSummary({ customerText: many });
    expect(turns).toHaveLength(AI_HISTORY_LIMITS.turns);
    expect(turns[turns.length - 1]).toBe('lượt 29');
    expect(historyFromSummary({ customerText: 'x'.repeat(3000) })[0]).toHaveLength(AI_HISTORY_LIMITS.chars);
  });
});

describe('addFeedback', () => {
  it('keeps the verdict with the turn it came after', () => {
    const state = { ...emptySummary(), turnCount: 3 };
    const next = addFeedback(state, 'wrong', '  em đã nói vệ sinh rồi ', 'Dạ khả năng cao là bẩn lưới lọc.', new Date('2026-10-16T00:00:00Z'));
    expect(next.feedback).toEqual([
      { at: '2026-10-16T00:00:00.000Z', verdict: 'wrong', note: 'em đã nói vệ sinh rồi', reply: 'Dạ khả năng cao là bẩn lưới lọc.', turn: 3 },
    ]);
  });

  it('keeps only the newest entries and bounded text', () => {
    let state = emptySummary();
    for (let i = 0; i < AI_FEEDBACK_LIMITS.entries + 5; i += 1) state = addFeedback(state, 'right', 'x'.repeat(500), null);
    expect(state.feedback).toHaveLength(AI_FEEDBACK_LIMITS.entries);
    expect(state.feedback![0].note!.length).toBeLessThanOrEqual(AI_FEEDBACK_LIMITS.note);
  });

  it('never reaches the booking summary the technician reads', () => {
    const state = addFeedback({ ...emptySummary(), deviceName: 'Máy lạnh' }, 'wrong', 'sai', null);
    expect(toBookingSummary(state)).not.toHaveProperty('feedback');
  });
});

describe('conversation notes', () => {
  it('keeps the AI notes, replaced each turn and bounded', () => {
    const reply = { status: 'ok', notesVi: ['Khách đã vệ sinh rồi, đã loại bẩn lưới lọc và dàn lạnh.', '', 'Khách nghi thiếu gas, xì gas.'] };
    const first = mergeTurn(emptySummary(), { text: 'mới vệ sinh rồi' }, reply);
    expect(first.notes).toEqual(['Khách đã vệ sinh rồi, đã loại bẩn lưới lọc và dàn lạnh.', 'Khách nghi thiếu gas, xì gas.']);
    const second = mergeTurn(first, { text: 'à nhầm chưa vệ sinh' }, { status: 'ok', notesVi: [] });
    expect(second.notes).toEqual([]);
    const many = mergeTurn(emptySummary(), {}, { status: 'ok', notesVi: Array.from({ length: 10 }, (_, i) => `Ghi chú ${i}`) });
    expect(many.notes).toHaveLength(AI_SUMMARY_LIMITS.notes);
    expect(hasAdvice({ ...emptySummary(), notes: ['Khách nghi thiếu gas.'] })).toBe(true);
  });

  it('keeps earlier notes when a reply says nothing about them', () => {
    const first = mergeTurn(emptySummary(), {}, { status: 'ok', notesVi: ['Khách nghi thiếu gas.'] });
    expect(mergeTurn(first, {}, { status: 'ok' }).notes).toEqual(['Khách nghi thiếu gas.']);
  });
});

describe('admin quality window', () => {
  it('starts at Vietnam midnight, days - 1 days back', () => {
    // 04:58 on 16/10 in Vietnam is 21:58 on 15/10 UTC
    const now = Date.parse('2026-10-15T21:58:00Z');
    expect(vnDaysWindowStart(7, now).toISOString()).toBe('2026-10-09T17:00:00.000Z'); // 00:00 10/10 VN
    expect(vnDaysWindowStart(1, now).toISOString()).toBe('2026-10-15T17:00:00.000Z'); // 00:00 16/10 VN
    // 23:30 on 16/10 in Vietnam is still 16/10
    expect(vnDaysWindowStart(1, Date.parse('2026-10-16T16:30:00Z')).toISOString()).toBe('2026-10-15T17:00:00.000Z');
    expect(vnDaysWindowStart(0, now).toISOString()).toBe('2026-10-15T17:00:00.000Z');
  });
});
