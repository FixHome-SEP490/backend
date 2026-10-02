// src/modules/messaging/messaging.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, LessThan, Repository } from 'typeorm';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { User } from '../users/entities/user.entity';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { ConversationStatus, Role } from '../../shared/enums';
import { EditMessageDto, ListMessagesQueryDto, SendMessageDto } from './messaging.dto';
import { Service } from '../services/entities/service.entity';
import { buildAcceptGreeting } from './accept-greeting';

export interface ChatActor {
  id: string;
  role: Role | string;
}

export interface ConversationParticipantView {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  role: string;
}

export interface ConversationView {
  id: string;
  bookingId: string;
  serviceOrderId: string | null;
  status: ConversationStatus;
  /** Booked service name, shown as the small note under the counterpart name. */
  serviceName: string | null;
  counterpart: ConversationParticipantView;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  canSend: boolean;
}

export interface MessageView {
  id: string;
  conversationId: string;
  senderId: string;
  content: string;
  createdAt: string;
  editedAt: string | null;
  isDeleted: boolean;
  clientMessageId: string | null;
  /** Sent by the system on the sender's behalf; clients show a small label. */
  isAutomated: boolean;
}

const DEFAULT_PAGE_SIZE = 30;
const PREVIEW_MAX_LENGTH = 255;
const RETRACTED_PREVIEW = 'Tin nhắn đã được gỡ';

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    @InjectRepository(Conversation)
    private readonly conversationRepo: Repository<Conversation>,
    @InjectRepository(Message)
    private readonly messageRepo: Repository<Message>,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  /**
   * Spec 8.6: the conversation opens when the Technician actually receives the
   * Booking. Called inside the matching transaction that flips an invitation to
   * PENDING, so chat and invitation can never disagree. Idempotent: replaying a
   * matching round must not create a second thread for the same pair.
   */
  async ensureConversation(
    manager: EntityManager,
    booking: Booking,
    technicianId: string,
  ): Promise<Conversation> {
    const existing = await manager.findOneBy(Conversation, {
      bookingId: booking.id,
      technicianId,
    });
    if (existing) return existing;

    const created = manager.create(Conversation, {
      bookingId: booking.id,
      customerId: booking.customerId,
      technicianId,
      status: ConversationStatus.ACTIVE,
      serviceNameSnapshot: booking.serviceNameSnapshot ?? null,
    });
    return manager.save(Conversation, created);
  }

  /**
   * Spec 8.6: on Accept the winning thread follows the ServiceOrder and every
   * other thread of that Booking becomes read-only. History is never deleted --
   * the losing threads stay readable, they just stop accepting messages.
   */
  async attachToServiceOrder(
    manager: EntityManager,
    bookingId: string,
    technicianId: string,
    serviceOrderId: string,
  ): Promise<void> {
    await manager.update(
      Conversation,
      { bookingId, technicianId },
      { serviceOrderId, status: ConversationStatus.ACTIVE },
    );
    await manager
      .createQueryBuilder()
      .update(Conversation)
      .set({ status: ConversationStatus.READ_ONLY })
      .where('booking_id = :bookingId AND technician_id != :technicianId', {
        bookingId,
        technicianId,
      })
      .execute();
  }

  // ------------------------------------------------------------- authorization

  private isParticipant(conversation: Conversation, actor: ChatActor): boolean {
    return (
      conversation.customerId === actor.id ||
      conversation.technicianId === actor.id
    );
  }

  /**
   * Ownership check that doubles as the IDOR guard. A non-participant gets the
   * same answer as a stranger asking for a row that does not exist, so thread
   * ids stay unguessable (OWNERSHIP_DENIED maps to 404 on purpose).
   */
  private async loadReadable(
    conversationId: string,
    actor: ChatActor,
  ): Promise<Conversation> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
      relations: ['customer', 'technician'],
    });
    const readable =
      conversation &&
      (this.isParticipant(conversation, actor) || actor.role === Role.ADMIN);
    if (!readable) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Conversation not found',
      );
    }
    return conversation;
  }

  /**
   * Writing needs more than reading: Admin is read-only on threads, and a thread
   * that lost the matching round is read-only for everyone.
   */
  private async loadWritable(
    conversationId: string,
    actor: ChatActor,
  ): Promise<Conversation> {
    const conversation = await this.loadReadable(conversationId, actor);
    if (!this.isParticipant(conversation, actor)) {
      throw new BusinessException(
        ErrorCodes.RBAC_FORBIDDEN,
        'Only the customer and the technician of this booking can send messages',
      );
    }
    if (conversation.status !== ConversationStatus.ACTIVE) {
      throw new BusinessException(
        ErrorCodes.CONFLICT,
        'This conversation is read-only',
      );
    }
    return conversation;
  }

  /** Rooms the socket may join. Membership is resolved server-side, never trusted from the client. */
  async listConversationIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.conversationRepo.find({
      where: [{ customerId: userId }, { technicianId: userId }],
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async isMember(conversationId: string, userId: string): Promise<boolean> {
    const count = await this.conversationRepo.count({
      where: [
        { id: conversationId, customerId: userId },
        { id: conversationId, technicianId: userId },
      ],
    });
    return count > 0;
  }

  /**
   * Authorisation and routing for a call invite, resolved in one query: it
   * returns the other participant, or null when this person may not start a
   * call in this thread.
   *
   * A call obeys the same rule as a message (CHAT-BR-01): it lives inside a
   * booking-scoped conversation and only while that conversation is ACTIVE.
   * Once the order closes and the thread turns read-only, neither side can
   * call any more. Returning the peer id from the same lookup means the
   * gateway never has to take a user id from the client.
   */
  async resolveCallPeer(
    conversationId: string,
    userId: string,
  ): Promise<string | null> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
      select: { id: true, customerId: true, technicianId: true, status: true },
    });
    if (!conversation) return null;
    if (conversation.status !== ConversationStatus.ACTIVE) return null;
    if (conversation.customerId === userId) return conversation.technicianId;
    if (conversation.technicianId === userId) return conversation.customerId;
    return null;
  }

  // ------------------------------------------------------------------ queries

  async listMyConversations(actor: ChatActor): Promise<ConversationView[]> {
    const conversations = await this.conversationRepo.find({
      where: [{ customerId: actor.id }, { technicianId: actor.id }],
      relations: ['customer', 'technician'],
      // Threads with recent messages first. PostgreSQL sorts NULL first under
      // DESC, which put every never-used thread above the live ones.
      order: { lastMessageAt: { direction: 'DESC', nulls: 'LAST' }, createdAt: 'DESC' },
    });
    if (conversations.length === 0) return [];

    const unread = await this.unreadCountsFor(actor.id);
    return conversations.map((conversation) =>
      this.toConversationView(
        conversation,
        actor,
        unread.get(conversation.id) ?? 0,
      ),
    );
  }

  async getConversation(
    conversationId: string,
    actor: ChatActor,
  ): Promise<ConversationView> {
    const conversation = await this.loadReadable(conversationId, actor);
    const unread = await this.unreadCountsFor(actor.id);
    return this.toConversationView(
      conversation,
      actor,
      unread.get(conversation.id) ?? 0,
    );
  }

  /**
   * Keyset paging on (conversation_id, created_at): the thread screen asks for
   * the newest page first and walks backwards with `before`, so scrolling up
   * stays O(page) no matter how long the history grows.
   */
  async listMessages(
    conversationId: string,
    actor: ChatActor,
    query: ListMessagesQueryDto,
  ): Promise<{ data: MessageView[]; nextBefore: string | null }> {
    await this.loadReadable(conversationId, actor);
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    let createdBefore: Date | undefined;
    if (query.before) {
      const parsed = new Date(query.before);
      if (Number.isNaN(parsed.getTime())) {
        throw new BusinessException(
          ErrorCodes.VALIDATION_FAILED,
          'before must be an ISO timestamp',
        );
      }
      createdBefore = parsed;
    }

    const rows = await this.messageRepo.find({
      where: {
        conversationId,
        ...(createdBefore ? { createdAt: LessThan(createdBefore) } : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit + 1,
    });

    const page = rows.slice(0, limit);
    const nextBefore =
      rows.length > limit && page.length > 0
        ? page[page.length - 1].createdAt.toISOString()
        : null;

    // Return oldest-first so the client can append without reversing.
    return {
      data: page.reverse().map((row) => this.toMessageView(row)),
      nextBefore,
    };
  }

  // ------------------------------------------------------------------ commands

  /**
   * The technician's first message on an accepted job, written for them: a
   * greeting with the order and the appointment, plus what the customer
   * already worked out with the assistant when the booking came from that
   * conversation. Called after the accept has committed; one per order and
   * technician, so a replayed accept does not send it twice. Returns null when
   * nothing was sent.
   */
  async postAcceptGreeting(params: {
    bookingId: string;
    technicianId: string;
    serviceOrderId: string;
    orderCode: string;
  }): Promise<MessageView | null> {
    const manager = this.conversationRepo.manager;
    const conversation = await manager.findOneBy(Conversation, {
      bookingId: params.bookingId,
      technicianId: params.technicianId,
    });
    if (!conversation || conversation.status !== ConversationStatus.ACTIVE) return null;

    const clientMessageId = `auto-accept:${params.serviceOrderId}`;
    const already = await this.messageRepo.findOneBy({
      conversationId: conversation.id,
      senderId: params.technicianId,
      clientMessageId,
    });
    if (already) return null;

    const booking = await manager.findOneBy(Booking, { id: params.bookingId });
    if (!booking) return null;
    const [technician, service] = await Promise.all([
      manager.findOne(User, { where: { id: params.technicianId }, select: { id: true, fullName: true } }),
      booking.serviceId
        ? manager.findOne(Service, { where: { id: booking.serviceId }, relations: { category: true } })
        : Promise.resolve(null),
    ]);

    const content = buildAcceptGreeting({
      technicianName: technician?.fullName ?? null,
      categoryName: service?.category?.name ?? null,
      serviceName: booking.serviceNameSnapshot ?? service?.name ?? null,
      orderCode: params.orderCode,
      preferredStartAt: booking.preferredStartAt ?? null,
      preferredEndAt: booking.preferredEndAt ?? null,
      aiSummary: booking.aiSummary ?? null,
    });

    const saved = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId: conversation.id,
        senderId: params.technicianId,
        content,
        clientMessageId,
        isAutomated: true,
      }),
    );
    await this.touchConversation(conversation, saved.createdAt, content);
    return this.toMessageView(saved);
  }

  async sendMessage(
    conversationId: string,
    actor: ChatActor,
    dto: SendMessageDto,
  ): Promise<{ message: MessageView; conversation: Conversation }> {
    const conversation = await this.loadWritable(conversationId, actor);

    // Replaying the same client id must not duplicate the bubble after a retry.
    if (dto.clientMessageId) {
      const duplicate = await this.messageRepo.findOneBy({
        conversationId,
        senderId: actor.id,
        clientMessageId: dto.clientMessageId,
      });
      if (duplicate) {
        return { message: this.toMessageView(duplicate), conversation };
      }
    }

    const saved = await this.messageRepo.save(
      this.messageRepo.create({
        conversationId,
        senderId: actor.id,
        content: dto.content,
        clientMessageId: dto.clientMessageId ?? null,
      }),
    );

    await this.touchConversation(conversation, saved.createdAt, dto.content);
    return { message: this.toMessageView(saved), conversation };
  }

  async editMessage(
    messageId: string,
    actor: ChatActor,
    dto: EditMessageDto,
  ): Promise<{ message: MessageView; conversation: Conversation }> {
    const message = await this.loadOwnMessage(messageId, actor);
    const conversation = await this.loadWritable(message.conversationId, actor);

    message.content = dto.content;
    message.editedAt = new Date();
    const saved = await this.messageRepo.save(message);

    if (await this.isLatestVisible(conversation.id, saved.id)) {
      await this.touchConversation(
        conversation,
        conversation.lastMessageAt ?? saved.createdAt,
        dto.content,
      );
    }
    return { message: this.toMessageView(saved), conversation };
  }

  /**
   * Retraction keeps the row and blanks the body. Deleting it outright would
   * renumber the thread under the other side while they are looking at it.
   */
  async deleteMessage(
    messageId: string,
    actor: ChatActor,
  ): Promise<{ message: MessageView; conversation: Conversation }> {
    const message = await this.loadOwnMessage(messageId, actor);
    const conversation = await this.loadWritable(message.conversationId, actor);

    message.deletedAt = new Date();
    message.content = '';
    const saved = await this.messageRepo.save(message);

    if (await this.isLatestVisible(conversation.id, saved.id)) {
      await this.touchConversation(
        conversation,
        conversation.lastMessageAt ?? saved.createdAt,
        RETRACTED_PREVIEW,
      );
    }
    return { message: this.toMessageView(saved), conversation };
  }

  async markRead(
    conversationId: string,
    actor: ChatActor,
  ): Promise<{ conversationId: string; readAt: string }> {
    const conversation = await this.loadReadable(conversationId, actor);
    const readAt = new Date();
    if (conversation.customerId === actor.id) {
      await this.conversationRepo.update(conversation.id, {
        customerLastReadAt: readAt,
      });
    } else if (conversation.technicianId === actor.id) {
      await this.conversationRepo.update(conversation.id, {
        technicianLastReadAt: readAt,
      });
    }
    return { conversationId: conversation.id, readAt: readAt.toISOString() };
  }

  // ------------------------------------------------------------------ helpers

  private async loadOwnMessage(
    messageId: string,
    actor: ChatActor,
  ): Promise<Message> {
    const message = await this.messageRepo.findOneBy({ id: messageId });
    if (!message || message.senderId !== actor.id) {
      throw new BusinessException(
        ErrorCodes.OWNERSHIP_DENIED,
        'Message not found',
      );
    }
    if (message.deletedAt) {
      throw new BusinessException(
        ErrorCodes.CONFLICT,
        'Message was already retracted',
      );
    }
    return message;
  }

  private async isLatestVisible(
    conversationId: string,
    messageId: string,
  ): Promise<boolean> {
    const latest = await this.messageRepo.findOne({
      where: { conversationId, deletedAt: IsNull() },
      order: { createdAt: 'DESC', id: 'DESC' },
      select: { id: true },
    });
    return !latest || latest.id === messageId;
  }

  private async touchConversation(
    conversation: Conversation,
    lastMessageAt: Date,
    preview: string,
  ): Promise<void> {
    const trimmed = preview.slice(0, PREVIEW_MAX_LENGTH);
    conversation.lastMessageAt = lastMessageAt;
    conversation.lastMessagePreview = trimmed;
    await this.conversationRepo.update(conversation.id, {
      lastMessageAt,
      lastMessagePreview: trimmed,
    });
  }

  private async unreadCountsFor(userId: string): Promise<Map<string, number>> {
    const rows: { id: string; unread: string }[] = await this.conversationRepo
      .manager.query(
        `SELECT m.conversation_id AS id, COUNT(*)::int AS unread
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE (c.customer_id = $1 OR c.technician_id = $1)
            AND m.sender_id <> $1
            AND m.deleted_at IS NULL
            AND m.created_at > COALESCE(
                  CASE WHEN c.customer_id = $1
                       THEN c.customer_last_read_at
                       ELSE c.technician_last_read_at END,
                  to_timestamp(0))
          GROUP BY m.conversation_id`,
        [userId],
      );
    return new Map(rows.map((row) => [row.id, Number(row.unread)]));
  }

  private toParticipantView(user: User | undefined): ConversationParticipantView {
    return {
      id: user?.id ?? '',
      fullName: user?.fullName ?? 'Người dùng FixHome',
      avatarUrl: user?.avatarUrl ?? null,
      role: user?.role ?? '',
    };
  }

  private toConversationView(
    conversation: Conversation,
    actor: ChatActor,
    unreadCount: number,
  ): ConversationView {
    const viewerIsCustomer = conversation.customerId === actor.id;
    const counterpart = viewerIsCustomer
      ? conversation.technician
      : conversation.customer;

    return {
      id: conversation.id,
      bookingId: conversation.bookingId,
      serviceOrderId: conversation.serviceOrderId ?? null,
      status: conversation.status,
      serviceName: conversation.serviceNameSnapshot ?? null,
      counterpart: this.toParticipantView(counterpart),
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      lastMessagePreview: conversation.lastMessagePreview ?? null,
      unreadCount,
      canSend:
        conversation.status === ConversationStatus.ACTIVE &&
        this.isParticipant(conversation, actor),
    };
  }

  private toMessageView(message: Message): MessageView {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      content: message.deletedAt ? '' : message.content,
      createdAt: message.createdAt.toISOString(),
      editedAt: message.editedAt?.toISOString() ?? null,
      isDeleted: !!message.deletedAt,
      clientMessageId: message.clientMessageId ?? null,
      isAutomated: message.isAutomated === true,
    };
  }

  /** Participants of a thread, used to fan out thread-list updates. */
  async participantIds(conversationId: string): Promise<string[]> {
    const conversation = await this.conversationRepo.findOne({
      where: { id: conversationId },
      select: { customerId: true, technicianId: true },
    });
    if (!conversation) return [];
    return [conversation.customerId, conversation.technicianId];
  }

  async conversationsByIds(ids: string[]): Promise<Conversation[]> {
    if (ids.length === 0) return [];
    return this.conversationRepo.find({ where: { id: In(ids) } });
  }
}
