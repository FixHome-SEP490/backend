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
});
