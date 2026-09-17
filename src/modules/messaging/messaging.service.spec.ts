import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagingService } from './messaging.service';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { ConversationStatus, Role } from '../../shared/enums';
import { ErrorCodes } from '../../shared/constants';
import { BusinessException } from '../../common/exceptions/business.exception';

const CUSTOMER = { id: 'c1', role: Role.CUSTOMER };
const TECHNICIAN = { id: 't1', role: Role.TECHNICIAN };
const OUTSIDER = { id: 'x9', role: Role.TECHNICIAN };
const ADMIN = { id: 'a1', role: Role.ADMIN };

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv1',
    bookingId: 'b1',
    customerId: CUSTOMER.id,
    technicianId: TECHNICIAN.id,
    serviceOrderId: null,
    status: ConversationStatus.ACTIVE,
    serviceNameSnapshot: 'Vệ sinh máy lạnh',
    lastMessageAt: null,
    lastMessagePreview: null,
    customerLastReadAt: null,
    technicianLastReadAt: null,
    createdAt: new Date('2026-09-17T10:00:00Z'),
    updatedAt: new Date('2026-09-17T10:00:00Z'),
    customer: { id: CUSTOMER.id, fullName: 'Khach Hang 1', avatarUrl: null, role: Role.CUSTOMER },
    technician: { id: TECHNICIAN.id, fullName: 'Tho Dien Lanh 1', avatarUrl: null, role: Role.TECHNICIAN },
    ...overrides,
  } as Conversation;
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    conversationId: 'conv1',
    senderId: CUSTOMER.id,
    content: 'Máy lạnh không lạnh',
    editedAt: null,
    deletedAt: null,
    clientMessageId: null,
    createdAt: new Date('2026-09-17T10:05:00Z'),
    updatedAt: new Date('2026-09-17T10:05:00Z'),
    ...overrides,
  } as Message;
}

describe('MessagingService', () => {
  let conversationRepo: any;
  let messageRepo: any;
  let service: MessagingService;

  beforeEach(() => {
    conversationRepo = {
      findOne: vi.fn(),
      findOneBy: vi.fn(),
      find: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue({ affected: 1 }),
      createQueryBuilder: vi.fn(),
      manager: { query: vi.fn().mockResolvedValue([]) },
    };
    messageRepo = {
      find: vi.fn().mockResolvedValue([]),
      findOne: vi.fn(),
      findOneBy: vi.fn(),
      create: vi.fn((v: unknown) => v),
      save: vi.fn(),
    };
    service = new MessagingService(conversationRepo, messageRepo);
  });

  describe('ensureConversation (spec 8.6: opens with the invitation)', () => {
    const booking = {
      id: 'b1',
      customerId: CUSTOMER.id,
      serviceNameSnapshot: 'Vệ sinh máy lạnh',
    } as Booking;

    it('creates one thread per (booking, technician) pair', async () => {
      const manager: any = {
        findOneBy: vi.fn().mockResolvedValue(null),
        create: vi.fn((_e: unknown, v: unknown) => v),
        save: vi.fn().mockImplementation((_e: unknown, v: unknown) => ({ id: 'conv1', ...(v as object) })),
      };

      const created = await service.ensureConversation(manager, booking, TECHNICIAN.id);

      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(created).toMatchObject({
        bookingId: 'b1',
        customerId: CUSTOMER.id,
        technicianId: TECHNICIAN.id,
        status: ConversationStatus.ACTIVE,
        serviceNameSnapshot: 'Vệ sinh máy lạnh',
      });
    });

    it('is idempotent: replaying a matching round does not fork the thread', async () => {
      const existing = makeConversation();
      const manager: any = {
        findOneBy: vi.fn().mockResolvedValue(existing),
        create: vi.fn(),
        save: vi.fn(),
      };

      const result = await service.ensureConversation(manager, booking, TECHNICIAN.id);

      expect(result).toBe(existing);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('attachToServiceOrder (spec 8.6: losers become read-only)', () => {
    it('binds the winner to the order and freezes the other threads', async () => {
      const execute = vi.fn().mockResolvedValue(undefined);
      const where = vi.fn().mockReturnValue({ execute });
      const set = vi.fn().mockReturnValue({ where });
      const update = vi.fn().mockReturnValue({ set });
      const manager: any = {
        update: vi.fn().mockResolvedValue({ affected: 1 }),
        createQueryBuilder: vi.fn().mockReturnValue({ update }),
      };

      await service.attachToServiceOrder(manager, 'b1', TECHNICIAN.id, 'so1');

      expect(manager.update).toHaveBeenCalledWith(
        Conversation,
        { bookingId: 'b1', technicianId: TECHNICIAN.id },
        { serviceOrderId: 'so1', status: ConversationStatus.ACTIVE },
      );
      expect(set).toHaveBeenCalledWith({ status: ConversationStatus.READ_ONLY });
      expect(where).toHaveBeenCalledWith(
        'booking_id = :bookingId AND technician_id != :technicianId',
        { bookingId: 'b1', technicianId: TECHNICIAN.id },
      );
    });
  });

  describe('authorization', () => {
    it('hides a thread from a non-participant (IDOR guard answers 404)', async () => {
      conversationRepo.findOne.mockResolvedValue(makeConversation());

      await expect(
        service.getConversation('conv1', OUTSIDER),
      ).rejects.toMatchObject({
        response: { code: ErrorCodes.OWNERSHIP_DENIED },
      });
    });

    it('hides a thread that does not exist with the same error', async () => {
      conversationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getConversation('nope', CUSTOMER),
      ).rejects.toBeInstanceOf(BusinessException);
    });

    it('lets a participant read their own thread', async () => {
      conversationRepo.findOne.mockResolvedValue(makeConversation());

      const view = await service.getConversation('conv1', TECHNICIAN);

      expect(view.id).toBe('conv1');
      // The technician sees the customer as counterpart, and vice versa.
      expect(view.counterpart.id).toBe(CUSTOMER.id);
      expect(view.serviceName).toBe('Vệ sinh máy lạnh');
      expect(view.canSend).toBe(true);
    });

    it('lets Admin read a thread but never write to it', async () => {
      conversationRepo.findOne.mockResolvedValue(makeConversation());

      const view = await service.getConversation('conv1', ADMIN);
      expect(view.id).toBe('conv1');
      expect(view.canSend).toBe(false);

      await expect(
        service.sendMessage('conv1', ADMIN, { content: 'hi' }),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.RBAC_FORBIDDEN } });
    });

    it('refuses to send into a read-only thread', async () => {
      conversationRepo.findOne.mockResolvedValue(
        makeConversation({ status: ConversationStatus.READ_ONLY }),
      );

      await expect(
        service.sendMessage('conv1', CUSTOMER, { content: 'hi' }),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    });
  });

  describe('sendMessage', () => {
    beforeEach(() => {
      conversationRepo.findOne.mockResolvedValue(makeConversation());
    });

    it('persists the message and updates the thread preview', async () => {
      messageRepo.findOneBy.mockResolvedValue(null);
      messageRepo.save.mockImplementation(async (v: Message) => ({
        ...makeMessage(),
        ...v,
      }));

      const { message } = await service.sendMessage('conv1', CUSTOMER, {
        content: 'Máy lạnh không lạnh',
      });

      expect(message.content).toBe('Máy lạnh không lạnh');
      expect(message.isDeleted).toBe(false);
      expect(conversationRepo.update).toHaveBeenCalledWith(
        'conv1',
        expect.objectContaining({ lastMessagePreview: 'Máy lạnh không lạnh' }),
      );
    });

    it('returns the existing row when the same clientMessageId is retried', async () => {
      const existing = makeMessage({ clientMessageId: 'abc123' });
      messageRepo.findOneBy.mockResolvedValue(existing);

      const { message } = await service.sendMessage('conv1', CUSTOMER, {
        content: 'Máy lạnh không lạnh',
        clientMessageId: 'abc123',
      });

      expect(message.id).toBe(existing.id);
      expect(messageRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('editMessage / deleteMessage', () => {
    beforeEach(() => {
      conversationRepo.findOne.mockResolvedValue(makeConversation());
      messageRepo.findOne.mockResolvedValue({ id: 'm1' });
      messageRepo.save.mockImplementation(async (v: Message) => v);
    });

    it('lets the sender edit and stamps editedAt', async () => {
      messageRepo.findOneBy.mockResolvedValue(makeMessage());

      const { message } = await service.editMessage('m1', CUSTOMER, {
        content: 'Máy lạnh chảy nước',
      });

      expect(message.content).toBe('Máy lạnh chảy nước');
      expect(message.editedAt).not.toBeNull();
    });

    it('refuses to edit someone else message', async () => {
      messageRepo.findOneBy.mockResolvedValue(makeMessage({ senderId: TECHNICIAN.id }));

      await expect(
        service.editMessage('m1', CUSTOMER, { content: 'sửa trộm' }),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.OWNERSHIP_DENIED } });
    });

    it('refuses to edit an already retracted message', async () => {
      messageRepo.findOneBy.mockResolvedValue(
        makeMessage({ deletedAt: new Date('2026-09-17T11:00:00Z') }),
      );

      await expect(
        service.editMessage('m1', CUSTOMER, { content: 'x' }),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.CONFLICT } });
    });

    it('retracts by tombstone, keeping the row and blanking the body', async () => {
      messageRepo.findOneBy.mockResolvedValue(makeMessage());

      const { message } = await service.deleteMessage('m1', CUSTOMER);

      expect(message.isDeleted).toBe(true);
      expect(message.content).toBe('');
      expect(messageRepo.save).toHaveBeenCalled();
    });
  });

  describe('listMessages', () => {
    beforeEach(() => {
      conversationRepo.findOne.mockResolvedValue(makeConversation());
    });

    it('returns oldest-first and reports no cursor on the last page', async () => {
      const older = makeMessage({ id: 'm1', createdAt: new Date('2026-09-17T10:00:00Z') });
      const newer = makeMessage({ id: 'm2', createdAt: new Date('2026-09-17T10:05:00Z') });
      // Repository returns newest-first; the service flips it for the client.
      messageRepo.find.mockResolvedValue([newer, older]);

      const page = await service.listMessages('conv1', CUSTOMER, { limit: 10 });

      expect(page.data.map((m) => m.id)).toEqual(['m1', 'm2']);
      expect(page.nextBefore).toBeNull();
    });

    it('hands back a keyset cursor when more history exists', async () => {
      const rows = [
        makeMessage({ id: 'm3', createdAt: new Date('2026-09-17T10:10:00Z') }),
        makeMessage({ id: 'm2', createdAt: new Date('2026-09-17T10:05:00Z') }),
        makeMessage({ id: 'm1', createdAt: new Date('2026-09-17T10:00:00Z') }),
      ];
      messageRepo.find.mockResolvedValue(rows);

      const page = await service.listMessages('conv1', CUSTOMER, { limit: 2 });

      expect(page.data.map((m) => m.id)).toEqual(['m2', 'm3']);
      expect(page.nextBefore).toBe(new Date('2026-09-17T10:05:00Z').toISOString());
    });

    it('rejects a malformed cursor instead of silently returning page one', async () => {
      await expect(
        service.listMessages('conv1', CUSTOMER, { before: 'not-a-date' }),
      ).rejects.toMatchObject({ response: { code: ErrorCodes.VALIDATION_FAILED } });
    });

    it('never leaks retracted content', async () => {
      messageRepo.find.mockResolvedValue([
        makeMessage({ id: 'm1', content: 'bí mật', deletedAt: new Date() }),
      ]);

      const page = await service.listMessages('conv1', CUSTOMER, {});

      expect(page.data[0].content).toBe('');
      expect(page.data[0].isDeleted).toBe(true);
    });
  });

  describe('markRead', () => {
    it('moves the read cursor of the side that asked', async () => {
      conversationRepo.findOne.mockResolvedValue(makeConversation());

      await service.markRead('conv1', TECHNICIAN);

      expect(conversationRepo.update).toHaveBeenCalledWith(
        'conv1',
        expect.objectContaining({ technicianLastReadAt: expect.any(Date) }),
      );
    });
  });
});
