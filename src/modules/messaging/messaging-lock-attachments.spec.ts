import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagingService } from './messaging.service';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { ChatAttachmentStorage } from './chat-attachment-storage.service';
import { ConversationStatus, Role, WARRANTY_CLAIM_ACTIVE_STATUSES } from '../../shared/enums';
import { ErrorCodes } from '../../shared/constants';
import { BusinessException } from '../../common/exceptions/business.exception';

const CUSTOMER = { id: 'c1', role: Role.CUSTOMER };
const TECHNICIAN = { id: 't1', role: Role.TECHNICIAN };
const OUTSIDER = { id: 'x9', role: Role.CUSTOMER };
const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(16)]);

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: CONVERSATION_ID,
    bookingId: 'b1',
    customerId: CUSTOMER.id,
    technicianId: TECHNICIAN.id,
    serviceOrderId: ORDER_ID,
    status: ConversationStatus.ACTIVE,
    serviceNameSnapshot: 'Sửa máy giặt',
    lastMessageAt: null,
    lastMessagePreview: null,
    customer: { id: CUSTOMER.id, fullName: 'Khách', avatarUrl: null, role: Role.CUSTOMER },
    technician: { id: TECHNICIAN.id, fullName: 'Thợ', avatarUrl: null, role: Role.TECHNICIAN },
    createdAt: new Date('2026-10-18T01:00:00Z'),
    updatedAt: new Date('2026-10-18T01:00:00Z'),
    ...overrides,
  } as Conversation;
}

/**
 * PO 18/10/2026: a completed order closes the chat; a warranty claim in progress
 * opens it again. The database answers which orders are closed; this harness
 * stands in for that query with the set of closed order ids.
 */
function harness(closedOrderIds: string[] = []) {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM service_orders so')) {
      const ids = params[0] as string[];
      return ids.filter((id) => closedOrderIds.includes(id)).map((id) => ({ id }));
    }
    return [];
  });
  const conversationRepo = {
    findOne: vi.fn(async () => conversation()),
    find: vi.fn(async () => [conversation()]),
    update: vi.fn(async () => ({ affected: 1 })),
    manager: { query },
  };
  const messageRepo = {
    findOneBy: vi.fn(async () => null),
    create: vi.fn((value: Partial<Message>) => value),
    save: vi.fn(async (value: Partial<Message>) => ({ id: 'm1', createdAt: new Date('2026-10-18T02:00:00Z'), editedAt: null, deletedAt: null, isAutomated: false, ...value })),
    createQueryBuilder: vi.fn(),
  };
  const storage = {
    inspect: vi.fn((file: { buffer: Buffer; mimetype: string; size: number }) => new ChatAttachmentStorage(null).inspect(file)),
    upload: vi.fn(async () => `cloudinary://chat-media/image/fixhome/chat-media/${CONVERSATION_ID}/33333333-3333-4333-8333-333333333333`),
    download: vi.fn(async () => ({ buffer: JPEG, mimeType: 'image/jpeg' as const })),
  };
  const service = new MessagingService(conversationRepo as never, messageRepo as never, storage as unknown as ChatAttachmentStorage);
  return { service, conversationRepo, messageRepo, storage, query };
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(BusinessException);
  return ((error as BusinessException).getResponse() as { code?: string }).code;
}

describe('Chat closes when the order is completed (PO 18/10/2026)', () => {
  it('lists the thread as closed with the reason, and open while a warranty claim is in progress', async () => {
    const closed = harness([ORDER_ID]);
    const [view] = await closed.service.listMyConversations(CUSTOMER);
    expect(view).toMatchObject({ canSend: false, closedReason: 'order_completed', status: ConversationStatus.ACTIVE });

    // The query is the one deciding: completed orders without an open claim, the claim statuses passed in.
    const [sql, params] = closed.query.mock.calls.find(([text]) => String(text).includes('FROM service_orders so'))!;
    expect(sql).toContain("NOT EXISTS");
    expect(params).toEqual([[ORDER_ID], 'completed', [...WARRANTY_CLAIM_ACTIVE_STATUSES]]);

    const open = harness([]);
    const [reopened] = await open.service.listMyConversations(CUSTOMER);
    expect(reopened).toMatchObject({ canSend: true, closedReason: null });
  });

  it('refuses a message, an edit, a retraction and a call in a closed thread', async () => {
    const { service, messageRepo } = harness([ORDER_ID]);
    expect(await errorCode(service.sendMessage(CONVERSATION_ID, CUSTOMER, { content: 'còn bảo hành không?' }))).toBe(ErrorCodes.CONVERSATION_CLOSED);
    expect(await errorCode(service.sendMessage(CONVERSATION_ID, TECHNICIAN, { content: 'chào anh' }))).toBe(ErrorCodes.CONVERSATION_CLOSED);
    messageRepo.findOneBy.mockResolvedValueOnce({ id: 'm1', conversationId: CONVERSATION_ID, senderId: CUSTOMER.id, deletedAt: null } as never);
    expect(await errorCode(service.editMessage('m1', CUSTOMER, { content: 'sửa' }))).toBe(ErrorCodes.CONVERSATION_CLOSED);
    expect(await service.resolveCallPeer(CONVERSATION_ID, CUSTOMER.id)).toBeNull();
    expect(messageRepo.save).not.toHaveBeenCalled();
  });

  it('lets both sides write again while a claim is open, and a thread with no order stays as it was', async () => {
    const { service, messageRepo } = harness([]);
    await expect(service.sendMessage(CONVERSATION_ID, CUSTOMER, { content: 'Máy lại kêu' })).resolves.toBeDefined();
    expect(await service.resolveCallPeer(CONVERSATION_ID, TECHNICIAN.id)).toBe(CUSTOMER.id);
    expect(messageRepo.save).toHaveBeenCalledOnce();

    const before = harness([ORDER_ID]);
    before.conversationRepo.findOne.mockResolvedValue(conversation({ serviceOrderId: null }));
    await expect(before.service.sendMessage(CONVERSATION_ID, CUSTOMER, { content: 'Chào anh' })).resolves.toBeDefined();
    expect(before.query).not.toHaveBeenCalledWith(expect.stringContaining('FROM service_orders so'), expect.anything());
  });

  it('keeps a losing thread read-only with no closed reason', async () => {
    const { service, conversationRepo } = harness([ORDER_ID]);
    conversationRepo.find.mockResolvedValue([conversation({ status: ConversationStatus.READ_ONLY })]);
    const [view] = await service.listMyConversations(TECHNICIAN);
    expect(view).toMatchObject({ canSend: false, closedReason: null, status: ConversationStatus.READ_ONLY });
  });
});

describe('Chat photos and videos (PO 18/10/2026)', () => {
  const file = (buffer: Buffer, mimetype: string) => ({ buffer, mimetype, size: buffer.length });

  it('stores a photo with its caption and shows it in the thread list preview', async () => {
    const { service, storage, conversationRepo, messageRepo } = harness();
    const { message } = await service.sendAttachment(CONVERSATION_ID, CUSTOMER, { content: 'Chỗ rò đây ạ 💧' }, file(JPEG, 'image/jpeg'));
    expect(storage.upload).toHaveBeenCalledWith(CONVERSATION_ID, 'image', expect.objectContaining({ size: JPEG.length }));
    expect(message).toMatchObject({ content: 'Chỗ rò đây ạ 💧', attachment: { kind: 'image', mimeType: 'image/jpeg', sizeBytes: JPEG.length } });
    expect(JSON.stringify(message)).not.toContain('cloudinary://');
    expect(messageRepo.save).toHaveBeenCalledWith(expect.objectContaining({ attachmentKind: 'image', attachmentMime: 'image/jpeg' }));
    expect(conversationRepo.update).toHaveBeenCalledWith(CONVERSATION_ID, expect.objectContaining({ lastMessagePreview: 'Chỗ rò đây ạ 💧' }));
  });

  it('stores a video without a caption and previews it as a video', async () => {
    const { service, conversationRepo } = harness();
    const { message } = await service.sendAttachment(CONVERSATION_ID, TECHNICIAN, {}, file(MP4, 'video/mp4'));
    expect(message).toMatchObject({ content: '', attachment: { kind: 'video', mimeType: 'video/mp4' } });
    expect(conversationRepo.update).toHaveBeenCalledWith(CONVERSATION_ID, expect.objectContaining({ lastMessagePreview: 'Đã gửi một video' }));
  });

  it.each([
    ['no file', undefined],
    ['a PDF', file(Buffer.from('%PDF-1.7'), 'application/pdf')],
    ['a photo claiming to be a video', file(JPEG, 'video/mp4')],
    ['a photo over 10 MB', file(Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)]), 'image/jpeg')],
  ])('refuses %s before storing anything', async (_label, upload) => {
    const { service, storage, messageRepo } = harness();
    await expect(service.sendAttachment(CONVERSATION_ID, CUSTOMER, {}, upload as never)).rejects.toThrow('Invalid chat attachment');
    expect(storage.upload).not.toHaveBeenCalled();
    expect(messageRepo.save).not.toHaveBeenCalled();
  });

  it('refuses an outsider and a closed thread, and replays the same client id without a second upload', async () => {
    const { service, storage, conversationRepo, messageRepo } = harness([ORDER_ID]);
    expect(await errorCode(service.sendAttachment(CONVERSATION_ID, CUSTOMER, {}, file(JPEG, 'image/jpeg')))).toBe(ErrorCodes.CONVERSATION_CLOSED);
    conversationRepo.findOne.mockResolvedValue(conversation({ serviceOrderId: null }));
    expect(await errorCode(service.sendAttachment(CONVERSATION_ID, OUTSIDER, {}, file(JPEG, 'image/jpeg')))).toBe(ErrorCodes.OWNERSHIP_DENIED);
    messageRepo.findOneBy.mockResolvedValueOnce({ id: 'm0', conversationId: CONVERSATION_ID, senderId: CUSTOMER.id, content: '', createdAt: new Date(), attachmentKind: 'image', attachmentMime: 'image/jpeg', attachmentSize: 8 } as never);
    const { message } = await service.sendAttachment(CONVERSATION_ID, CUSTOMER, { clientMessageId: 'retry-1' }, file(JPEG, 'image/jpeg'));
    expect(message.id).toBe('m0');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('serves the bytes to participants and hides them after retraction', async () => {
    const { service, storage, messageRepo } = harness([ORDER_ID]);
    const row = { id: 'm1', conversationId: CONVERSATION_ID, senderId: CUSTOMER.id, deletedAt: null as Date | null, attachmentKind: 'image', attachmentRef: 'cloudinary://chat-media/image/x' };
    const qb = { addSelect: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), getOne: vi.fn(async () => row) };
    messageRepo.createQueryBuilder.mockReturnValue(qb);
    // Reading stays allowed in a closed thread: the history is not taken away.
    await expect(service.attachmentContent('m1', TECHNICIAN)).resolves.toEqual({ buffer: JPEG, mimeType: 'image/jpeg' });
    expect(storage.download).toHaveBeenCalledWith('cloudinary://chat-media/image/x', CONVERSATION_ID);
    expect(await errorCode(service.attachmentContent('m1', OUTSIDER))).toBe(ErrorCodes.OWNERSHIP_DENIED);
    row.deletedAt = new Date();
    expect(await errorCode(service.attachmentContent('m1', CUSTOMER))).toBe(ErrorCodes.OWNERSHIP_DENIED);
  });
});
