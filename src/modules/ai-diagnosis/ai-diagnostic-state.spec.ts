// PO 01/11/2026 (AI audit approved): the diagnostic state of an assistant
// conversation is kept here, not only in the AI Service's memory. It is sent
// back with the next message, replaced only by a higher version, never shown
// in full to the client, and a repeated message gets the reply already given.
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { AiDiagnosisService, splitState } from './ai-diagnosis.service';
import { emptySummary } from './ai-chat-summary';

const CUSTOMER = { id: 'customer-a', role: 'customer' };
const STATE = (version: number) => ({
  canonical: { schemaVersion: 1, stateVersion: version, sessionId: 'sess-1', diagnosisStatus: 'POSSIBLE', devices: [], qa: [] },
  engine: { schemaVersion: 1, conversation: { __dc__: 'Conversation', session_id: 'sess-1' }, children: {} },
});
const REPLY = (version: number) => ({
  sessionId: 'sess-1',
  status: 'ok',
  suspectedFaults: [{ faultCode: 'AC_DRAIN_BLOCKED', nameVi: 'Nghẹt đường thoát nước' }],
  recommendedServices: [],
  messageVi: 'Dạ có thể nghẹt đường thoát nước ạ.',
  modelInfo: { vlm: 'Qwen/Qwen2.5-VL-3B-Instruct-AWQ', knowledgeBaseVersion: '2026-09-17' },
  diagnosticState: STATE(version),
  stateVersion: version,
});

describe('splitState', () => {
  it('keeps the whole state for the server and gives the client only the canonical part', () => {
    const { reply, state, stateVersion } = splitState(REPLY(3));
    expect(stateVersion).toBe(3);
    expect(state).toEqual(STATE(3));
    expect(reply.diagnosticState).toEqual(STATE(3).canonical);
    expect(JSON.stringify(reply)).not.toContain('engine');
  });

  it('passes an older AI Service reply through untouched', () => {
    const old = { sessionId: 'sess-1', status: 'ok', messageVi: 'x' };
    expect(splitState(old)).toEqual({ reply: old, state: null, stateVersion: null });
    expect(splitState({ ...old, diagnosticState: [], stateVersion: 2 }).state).toBeNull();
    expect(splitState({ ...old, diagnosticState: STATE(1), stateVersion: 0 }).state).toBeNull();
  });
});

describe('diagnostic state across messages', () => {
  let http: any;
  let sessions: any;
  let turns: any;
  let updateWhere: any;
  let service: AiDiagnosisService;

  beforeEach(() => {
    http = { post: vi.fn().mockReturnValue(of({ data: REPLY(1) })), get: vi.fn() };
    updateWhere = vi.fn().mockReturnValue({ execute: vi.fn().mockResolvedValue({ affected: 1 }) });
    const builder = { update: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(), where: updateWhere };
    sessions = {
      findOneBy: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      createQueryBuilder: vi.fn().mockReturnValue(builder),
      builder,
    };
    turns = { findOne: vi.fn().mockResolvedValue(null), insert: vi.fn().mockResolvedValue({}) };
    const diagnosisRepo = { manager: { findOneBy: vi.fn(), find: vi.fn().mockResolvedValue([]) } };
    const serviceRepo = { find: vi.fn().mockResolvedValue([]) };
    const config = { get: vi.fn().mockReturnValue('http://ai.test') };
    service = new AiDiagnosisService(diagnosisRepo as any, serviceRepo as any, http, config as any, sessions, turns);
  });

  it('stores the first state with its version and returns only the canonical part', async () => {
    const reply = await service.analyze({ description: 'máy lạnh chảy nước' }, CUSTOMER);
    expect(sessions.insert).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-1', diagnosticState: STATE(1), stateVersion: 1 }));
    expect(reply.diagnosticState).toEqual(STATE(1).canonical);
    expect(reply.stateVersion).toBe(1);
    expect(JSON.stringify(reply)).not.toContain('"engine"');
  });

  it('sends the stored state back with the next message of the same customer', async () => {
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-a', summary: { customerText: 'trước đó' }, diagnosticState: STATE(2), stateVersion: 2 });
    http.post.mockReturnValue(of({ data: REPLY(3) }));
    await service.analyze({ description: 'Không.', sessionId: 'sess-1' }, CUSTOMER);
    expect(http.post.mock.calls[0][1]).toMatchObject({ sessionId: 'sess-1', diagnosticState: STATE(2) });
  });

  it('never sends another customer\'s state', async () => {
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-b', summary: {}, diagnosticState: STATE(2), stateVersion: 2 });
    await service.analyze({ description: 'x', sessionId: 'sess-1' }, CUSTOMER);
    expect(http.post.mock.calls[0][1].diagnosticState).toBeUndefined();
  });

  it('replaces the stored state only with a higher version', async () => {
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-a', summary: emptySummary(), diagnosticState: STATE(2), stateVersion: 2 });
    http.post.mockReturnValue(of({ data: REPLY(3) }));
    await service.analyze({ description: 'Bên phải dàn lạnh.', sessionId: 'sess-1' }, CUSTOMER);
    expect(sessions.builder.set).toHaveBeenCalledWith({ diagnosticState: STATE(3), stateVersion: 3 });
    expect(updateWhere).toHaveBeenCalledWith('id = :id AND state_version < :version', { id: 'row', version: 3 });
  });

  it('records the turn and answers a repeated message with the reply already given', async () => {
    const first = await service.analyze({ description: 'máy lạnh chảy nước', clientMessageId: 'msg-00000001' } as any, CUSTOMER);
    expect(turns.insert).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-1', clientMessageId: 'msg-00000001', route: 'analyze', status: 'ok', stateVersion: 1,
      model: 'Qwen/Qwen2.5-VL-3B-Instruct-AWQ', kbVersion: '2026-09-17',
    }));
    turns.findOne.mockResolvedValue({ sessionId: 'sess-1', response: first });
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-a', summary: {} });
    http.post.mockClear();
    const again = await service.analyze({ description: 'máy lạnh chảy nước', clientMessageId: 'msg-00000001' } as any, CUSTOMER);
    expect(http.post).not.toHaveBeenCalled();
    expect(again).toMatchObject({ messageVi: first.messageVi, repeated: true });
  });

  it('does not hand one customer the reply another customer got for the same message id', async () => {
    turns.findOne.mockResolvedValue({ sessionId: 'sess-1', response: { messageVi: 'của người khác' } });
    sessions.findOneBy.mockResolvedValue({ id: 'row', sessionId: 'sess-1', customerId: 'customer-b', summary: {} });
    const reply = await service.analyze({ description: 'x', clientMessageId: 'msg-00000002' } as any, CUSTOMER);
    expect(reply.messageVi).not.toBe('của người khác');
    expect(http.post).toHaveBeenCalled();
  });
});
