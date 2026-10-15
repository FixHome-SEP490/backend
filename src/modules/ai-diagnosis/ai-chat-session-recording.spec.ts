// Recording the assistant conversation so a booking made from it can carry a
// summary to the technician. The reply must reach the customer no matter what
// happens to the recording, and one customer's session is never written by
// another.
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { AiDiagnosisService } from './ai-diagnosis.service';

const REPLY = {
  sessionId: 'sess-1',
  status: 'ok',
  device: { nameVi: 'Máy lạnh' },
  suspectedFaults: [{ nameVi: 'Hỏng mô tơ quạt dàn lạnh' }],
  recommendedServices: [],
  priceEstimate: { min: 100000, max: 300000, requiresAssessment: true },
  messageVi: 'Có thể quạt bị kẹt.',
};
const CUSTOMER = { id: 'customer-a', role: 'customer' };

describe('AI session recording', () => {
  let http: any;
  let sessions: any;
  let service: AiDiagnosisService;

  beforeEach(() => {
    http = { post: vi.fn().mockReturnValue(of({ data: structuredClone(REPLY) })), get: vi.fn() };
    sessions = {
      findOneBy: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    };
    const diagnosisRepo = { manager: { findOneBy: vi.fn() } };
    const serviceRepo = { find: vi.fn().mockResolvedValue([]) };
    const config = { get: vi.fn().mockReturnValue('http://ai.test') };
    service = new AiDiagnosisService(diagnosisRepo as any, serviceRepo as any, http, config as any, sessions);
  });

  it('starts a session summary owned by the signed-in customer', async () => {
    await service.analyze({ description: 'kêu lạch cạch', images: ['a', 'b'] }, CUSTOMER);
    expect(sessions.insert).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      customerId: 'customer-a',
      summary: expect.objectContaining({ deviceName: 'Máy lạnh', photoCount: 2, customerText: 'kêu lạch cạch', priceMin: 100000 }),
    }));
  });

  it('extends an existing session and lets a customer claim an anonymous one', async () => {
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: null, summary: { deviceName: null, customerText: 'trước đó', suspectedFaults: [], suggestedActions: [], conclusion: null, priceMin: null, priceMax: null, requiresAssessment: null, recommendedServiceName: null, photoCount: 1, turnCount: 1 } });
    await service.ask({ question: 'giá bao nhiêu?' }, CUSTOMER);
    expect(sessions.update).toHaveBeenCalledWith('row', expect.objectContaining({
      customerId: 'customer-a',
      summary: expect.objectContaining({ customerText: 'trước đó / giá bao nhiêu?', photoCount: 1, turnCount: 2 }),
    }));
  });

  it('never writes into another customer\'s session', async () => {
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-b', summary: {} });
    const reply = await service.ask({ question: 'xin chào', sessionId: 'sess-1' }, CUSTOMER);
    expect(sessions.update).not.toHaveBeenCalled();
    expect(sessions.insert).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ aiAvailable: true });
  });

  it('records nothing when the AI is down, and still answers', async () => {
    http.post.mockReturnValue(throwError(() => new Error('ECONNREFUSED')));
    const reply = await service.analyze({ description: 'x' }, CUSTOMER);
    expect(reply).toMatchObject({ status: 'unavailable', aiAvailable: false });
    expect(sessions.findOneBy).not.toHaveBeenCalled();
  });

  it('still answers when the summary cannot be stored', async () => {
    sessions.findOneBy.mockRejectedValue(new Error('db down'));
    const reply = await service.analyze({ description: 'x' }, CUSTOMER);
    expect(reply).toMatchObject({ aiAvailable: true, sessionId: 'sess-1' });
  });

  it('ignores a reply without a usable session id', async () => {
    http.post.mockReturnValue(of({ data: { ...REPLY, sessionId: 'x'.repeat(200) } }));
    await service.analyze({ description: 'x' }, CUSTOMER);
    http.post.mockReturnValue(of({ data: { ...REPLY, sessionId: undefined } }));
    await service.analyze({ description: 'x' }, CUSTOMER);
    expect(sessions.findOneBy).not.toHaveBeenCalled();
  });

  it('keeps anonymous advice anonymous, and does not tie staff to a session', async () => {
    await service.ask({ question: 'hỏi' });
    await service.ask({ question: 'hỏi' }, { id: 'sm-1', role: 'service_manager' });
    expect(sessions.insert.mock.calls.every(([row]: [{ customerId: string | null }]) => row.customerId === null)).toBe(true);
  });
  // ------------------------------------------------ earlier repairs

  const BOOKING = { serviceNameSnapshot: 'Sửa điều hòa', createdAt: new Date('2026-08-03T03:00:00Z'), aiSummary: { deviceName: 'Máy lạnh', suspectedFaults: [] } };

  function withBookings(find: any) {
    const diagnosisRepo = { manager: { findOneBy: vi.fn(), find } };
    const config = { get: vi.fn().mockReturnValue('http://ai.test') };
    return new AiDiagnosisService(diagnosisRepo as any, { find: vi.fn().mockResolvedValue([]) } as any, http, config as any, sessions);
  }

  it("sends a signed-in customer's own earlier repairs, and only theirs", async () => {
    const find = vi.fn().mockResolvedValue([BOOKING]);
    await withBookings(find).ask({ question: 'máy lạnh không mát' }, CUSTOMER);
    expect(http.post.mock.calls[0][1].pastJobs).toEqual([{ serviceVi: 'Sửa điều hòa', deviceVi: 'Máy lạnh', date: '2026-08-03' }]);
    expect(find.mock.calls[0][1]).toMatchObject({ where: { customerId: 'customer-a', status: 'matched' }, take: 5 });
  });

  it('sends none for a visitor or staff, without reading bookings', async () => {
    const find = vi.fn().mockResolvedValue([BOOKING]);
    const svc = withBookings(find);
    await svc.ask({ question: 'hỏi' });
    await svc.analyze({ description: 'hỏi' }, { id: 'tech-1', role: 'technician' });
    expect(find).not.toHaveBeenCalled();
    expect(http.post.mock.calls.every(([, body]: [string, object]) => !('pastJobs' in body))).toBe(true);
  });

  it('still answers when bookings cannot be read, or an older AI Service rejects the field', async () => {
    await withBookings(vi.fn().mockRejectedValue(new Error('db down'))).ask({ question: 'x' }, CUSTOMER);
    expect(http.post.mock.calls[0][1]).not.toHaveProperty('pastJobs');
    http.post.mockReset();
    http.post
      .mockReturnValueOnce(throwError(() => ({ response: { status: 422 } })))
      .mockReturnValue(of({ data: structuredClone(REPLY) }));
    const reply = await withBookings(vi.fn().mockResolvedValue([BOOKING])).ask({ question: 'x' }, CUSTOMER);
    expect(http.post.mock.calls[0][1]).toHaveProperty('pastJobs');
    expect(http.post.mock.calls[1][1]).not.toHaveProperty('pastJobs');
    expect(reply).toMatchObject({ aiAvailable: true });
  });

  // ------------------------------------------------ rebuilding a lost session

  const SUMMARY = {
    deviceName: 'Máy lạnh', customerText: 'máy lạnh không mát / mới vệ sinh tuần trước rồi', suspectedFaults: [],
    suggestedActions: [], conclusion: null, priceMin: null, priceMax: null, requiresAssessment: null,
    recommendedServiceName: null, photoCount: 0, turnCount: 2,
  };

  it('sends the AI what the customer said earlier, from the recorded session', async () => {
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-a', summary: SUMMARY });
    await service.ask({ question: 'vậy giờ là bị gì', sessionId: 'sess-1' }, CUSTOMER);
    expect(http.post).toHaveBeenCalledWith('http://ai.test/api/v1/chat/ask', expect.objectContaining({
      sessionId: 'sess-1',
      history: ['máy lạnh không mát', 'mới vệ sinh tuần trước rồi'],
    }));
  });

  it("never sends another customer's conversation as history", async () => {
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-b', summary: SUMMARY });
    await service.analyze({ description: 'vậy giờ là bị gì', sessionId: 'sess-1' }, CUSTOMER);
    expect(http.post.mock.calls[0][1]).not.toHaveProperty('history');
  });

  it('sends no history for a new conversation or when the record cannot be read', async () => {
    await service.ask({ question: 'máy lạnh không mát' }, CUSTOMER);
    expect(http.post.mock.calls[0][1]).not.toHaveProperty('history');
    sessions.findOneBy.mockRejectedValueOnce(new Error('db down'));
    const reply = await service.ask({ question: 'x', sessionId: 'sess-1' }, CUSTOMER);
    expect(http.post.mock.calls[1][1]).not.toHaveProperty('history');
    expect(reply).toMatchObject({ aiAvailable: true });
  });

  it('retries without history when an older AI Service rejects the field', async () => {
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-a', summary: SUMMARY });
    http.post
      .mockReturnValueOnce(throwError(() => ({ message: 'Unprocessable', response: { status: 422 } })))
      .mockReturnValueOnce(of({ data: structuredClone(REPLY) }));
    const reply = await service.analyze({ description: 'vậy giờ là bị gì', sessionId: 'sess-1' }, CUSTOMER);
    expect(http.post).toHaveBeenCalledTimes(2);
    expect(http.post.mock.calls[0][1]).toHaveProperty('history');
    expect(http.post.mock.calls[1][1]).not.toHaveProperty('history');
    expect(reply).toMatchObject({ aiAvailable: true });
  });

  it('does not retry other failures, and still answers that the AI is unavailable', async () => {
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-a', summary: SUMMARY });
    http.post.mockReturnValue(throwError(() => ({ message: 'boom', response: { status: 500 } })));
    const reply = await service.ask({ question: 'x', sessionId: 'sess-1' }, CUSTOMER);
    expect(http.post).toHaveBeenCalledTimes(1);
    expect(reply).toMatchObject({ aiAvailable: false });
  });

  it('carries the summary over when the AI starts a new session in place of a lost one', async () => {
    sessions.findOneBy.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
      sessionId === 'old-id' ? { id: 'old-row', sessionId: 'old-id', customerId: 'customer-a', summary: SUMMARY } : null);
    await service.ask({ question: 'vậy giờ là bị gì', sessionId: 'old-id' }, CUSTOMER);
    expect(sessions.insert).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1',
      customerId: 'customer-a',
      summary: expect.objectContaining({
        customerText: 'máy lạnh không mát / mới vệ sinh tuần trước rồi / vậy giờ là bị gì',
        turnCount: 3,
      }),
    }));
  });

  it('does not carry over a lost session another customer held', async () => {
    sessions.findOneBy.mockImplementation(async ({ sessionId }: { sessionId: string }) =>
      sessionId === 'old-id' ? { id: 'old-row', sessionId: 'old-id', customerId: 'customer-b', summary: SUMMARY } : null);
    await service.ask({ question: 'hỏi', sessionId: 'old-id' }, CUSTOMER);
    expect(sessions.insert).toHaveBeenCalledWith(expect.objectContaining({
      summary: expect.objectContaining({ customerText: 'hỏi', turnCount: 1 }),
    }));
  });
});
