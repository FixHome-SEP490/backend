import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagingService } from './messaging.service';
import { AcceptGreetingPublisher } from './accept-greeting.publisher';
import { Conversation } from './entities/conversation.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { Service } from '../services/entities/service.entity';
import { ConversationStatus } from '../../shared/enums';
import { emptySummary, mergeTurn, toBookingSummary } from '../ai-diagnosis/ai-chat-summary';

const PARAMS = { bookingId: 'b1', technicianId: 't1', serviceOrderId: 'so1', orderCode: 'FH-20261001-AAAA0001' };

function setup(overrides: { conversation?: Record<string, unknown> | null; booking?: Record<string, unknown> | null; existing?: unknown } = {}) {
  const conversation = overrides.conversation === undefined
    ? { id: 'conv1', bookingId: 'b1', technicianId: 't1', customerId: 'c1', status: ConversationStatus.ACTIVE }
    : overrides.conversation;
  const booking = overrides.booking === undefined
    ? { id: 'b1', serviceId: 's1', serviceNameSnapshot: 'Sửa điều hòa', preferredStartAt: new Date('2026-10-02T02:00:00Z'), preferredEndAt: new Date('2026-10-02T04:00:00Z'), aiSummary: null }
    : overrides.booking;
  const manager = {
    findOneBy: vi.fn(async (entity: unknown) => (entity === Conversation ? conversation : entity === Booking ? booking : null)),
    findOne: vi.fn(async (entity: unknown) => (entity === User ? { id: 't1', fullName: 'Nguyễn Văn An' } : entity === Service ? { id: 's1', name: 'Sửa điều hòa', category: { name: 'Điện lạnh' } } : null)),
  };
  const conversationRepo = { manager, update: vi.fn(), findOne: vi.fn(async () => ({ customerId: 'c1', technicianId: 't1' })) };
  const messageRepo = {
    findOneBy: vi.fn(async () => overrides.existing ?? null),
    create: vi.fn((row: Record<string, unknown>) => row),
    save: vi.fn(async (row: Record<string, unknown>) => ({ id: 'm1', createdAt: new Date('2026-10-01T10:00:00Z'), editedAt: null, deletedAt: null, ...row })),
  };
  const service = new MessagingService(conversationRepo as never, messageRepo as never);
  return { service, messageRepo, conversationRepo };
}

describe('Technician greeting on accept', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it('posts one automated message from the technician and updates the thread preview', async () => {
    const view = await s.service.postAcceptGreeting(PARAMS);
    expect(s.messageRepo.save).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: 'conv1', senderId: 't1', isAutomated: true, clientMessageId: 'auto-accept:so1',
    }));
    expect(view).toMatchObject({ senderId: 't1', isAutomated: true });
    expect(view!.content).toContain('tôi là Nguyễn Văn An, kỹ thuật viên mảng Điện lạnh của FixHome');
    expect(view!.content).toContain('lịch hẹn 09:00–11:00 ngày 02/10/2026');
    expect(s.conversationRepo.update).toHaveBeenCalledWith('conv1', expect.objectContaining({ lastMessagePreview: expect.stringContaining('Chào anh/chị') }));
  });

  it('includes the assistant summary frozen on the booking', async () => {
    const aiSummary = toBookingSummary(mergeTurn(emptySummary(), { text: 'kêu lạch cạch', photoCount: 2 }, {
      status: 'ok', device: { nameVi: 'Máy lạnh' }, suspectedFaults: [{ nameVi: 'Hỏng mô tơ quạt' }], priceEstimate: { min: 100000, max: 300000 },
    }));
    s = setup({ booking: { id: 'b1', serviceId: 's1', serviceNameSnapshot: 'Sửa điều hòa', preferredStartAt: null, preferredEndAt: null, aiSummary } });
    const view = await s.service.postAcceptGreeting(PARAMS);
    expect(view!.content).toContain('trợ lý AI');
    expect(view!.content).toContain('Hỏng mô tơ quạt');
    expect(view!.content).toContain('100.000 ₫ – 300.000 ₫');
  });

  it('does not send twice for the same order', async () => {
    s = setup({ existing: { id: 'old' } });
    expect(await s.service.postAcceptGreeting(PARAMS)).toBeNull();
    expect(s.messageRepo.save).not.toHaveBeenCalled();
  });

  it.each([
    ['no conversation', { conversation: null }],
    ['a read-only conversation', { conversation: { id: 'conv1', status: ConversationStatus.READ_ONLY } }],
    ['a missing booking', { booking: null }],
  ])('sends nothing for %s', async (_label, overrides) => {
    s = setup(overrides as never);
    expect(await s.service.postAcceptGreeting(PARAMS)).toBeNull();
    expect(s.messageRepo.save).not.toHaveBeenCalled();
  });
});

describe('AcceptGreetingPublisher', () => {
  it('publishes the greeting to the thread and to both participants', async () => {
    const message = { id: 'm1', conversationId: 'conv1' };
    const messaging = { postAcceptGreeting: vi.fn(async () => message), participantIds: vi.fn(async () => ['c1', 't1']) };
    const gateway = { emitMessageCreated: vi.fn(), emitConversationTouched: vi.fn() };
    await new AcceptGreetingPublisher(messaging as never, gateway as never).send(PARAMS);
    expect(gateway.emitMessageCreated).toHaveBeenCalledWith(message);
    expect(gateway.emitConversationTouched).toHaveBeenCalledWith(['c1', 't1'], 'conv1');
  });

  it('swallows failures so the accept itself is never affected', async () => {
    const messaging = { postAcceptGreeting: vi.fn(async () => { throw new Error('db down'); }), participantIds: vi.fn() };
    const gateway = { emitMessageCreated: vi.fn(), emitConversationTouched: vi.fn() };
    await expect(new AcceptGreetingPublisher(messaging as never, gateway as never).send(PARAMS)).resolves.toBeUndefined();
    expect(gateway.emitMessageCreated).not.toHaveBeenCalled();
  });

  it('publishes nothing when nothing was sent', async () => {
    const messaging = { postAcceptGreeting: vi.fn(async () => null), participantIds: vi.fn() };
    const gateway = { emitMessageCreated: vi.fn(), emitConversationTouched: vi.fn() };
    await new AcceptGreetingPublisher(messaging as never, gateway as never).send(PARAMS);
    expect(gateway.emitMessageCreated).not.toHaveBeenCalled();
  });
});
