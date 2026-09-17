// src/modules/messaging/messaging.gateway.ts
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { User } from '../users/entities/user.entity';
import { AccountStatus, Role } from '../../shared/enums';
import { ChatActor, MessageView, MessagingService } from './messaging.service';

interface ChatSocket extends Socket {
  data: { user?: ChatActor };
}

export const CHAT_EVENTS = {
  MESSAGE_NEW: 'message:new',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  CONVERSATION_UPDATED: 'conversation:updated',
  TYPING: 'typing',
} as const;

const conversationRoom = (conversationId: string) => `conversation:${conversationId}`;
const userRoom = (userId: string) => `user:${userId}`;

/**
 * Realtime transport for booking-scoped chat (spec 8.23: WebSocket is the
 * transport, persistence is the source of truth).
 *
 * Every socket is authenticated from its own JWT before it joins anything, and
 * room membership is resolved from the database. The client never tells the
 * server who it is, so a message cannot be delivered to the wrong person.
 */
@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: true, credentials: true },
})
export class MessagingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MessagingGateway.name);

  constructor(
    private readonly messagingService: MessagingService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  // ---------------------------------------------------------------- lifecycle

  async handleConnection(client: ChatSocket): Promise<void> {
    const actor = await this.authenticate(client);
    if (!actor) {
      client.emit('connect:error', { message: 'Unauthorized' });
      client.disconnect(true);
      return;
    }

    client.data.user = actor;
    await client.join(userRoom(actor.id));

    const conversationIds =
      await this.messagingService.listConversationIdsForUser(actor.id);
    for (const id of conversationIds) {
      await client.join(conversationRoom(id));
    }

    client.emit('connect:ready', { userId: actor.id, conversationIds });
  }

  handleDisconnect(client: ChatSocket): void {
    const userId = client.data?.user?.id;
    if (userId) {
      this.logger.debug(`Chat socket disconnected for user ${userId}`);
    }
  }

  /**
   * The token travels in the socket handshake, never in a query string, so it
   * does not end up in proxy or server access logs.
   */
  private async authenticate(client: ChatSocket): Promise<ChatActor | null> {
    const raw =
      (client.handshake.auth?.token as string | undefined) ??
      this.bearerFrom(client.handshake.headers?.authorization);
    if (!raw) return null;

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub?: string;
        role?: Role;
      }>(raw, {
        secret: this.configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
        algorithms: ['HS256'],
      });
      if (!payload?.sub) return null;

      // Re-read the account: a token minted before a lock must not keep working.
      const user = await this.userRepo.findOne({ where: { id: payload.sub } });
      if (!user || user.status !== AccountStatus.ACTIVE || !user.isActive) {
        return null;
      }
      return { id: user.id, role: user.role };
    } catch {
      return null;
    }
  }

  private bearerFrom(header?: string): string | undefined {
    if (!header?.startsWith('Bearer ')) return undefined;
    return header.slice('Bearer '.length).trim() || undefined;
  }

  // ------------------------------------------------------------ client events

  /** Joining a thread opened after the socket connected (a new invitation). */
  @SubscribeMessage('conversation:join')
  async onJoin(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: string },
  ): Promise<{ joined: boolean }> {
    const actor = client.data?.user;
    const conversationId = body?.conversationId;
    if (!actor || !conversationId) return { joined: false };

    if (!(await this.messagingService.isMember(conversationId, actor.id))) {
      return { joined: false };
    }
    await client.join(conversationRoom(conversationId));
    return { joined: true };
  }

  @SubscribeMessage('conversation:leave')
  async onLeave(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: string },
  ): Promise<{ left: boolean }> {
    if (!body?.conversationId) return { left: false };
    await client.leave(conversationRoom(body.conversationId));
    return { left: true };
  }

  /**
   * Typing is deliberately not persisted: it is a hint, and a stale hint is
   * worse than none. It is broadcast to the rest of the room only.
   */
  @SubscribeMessage('typing')
  async onTyping(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: string; isTyping?: boolean },
  ): Promise<{ ok: boolean }> {
    const actor = client.data?.user;
    const conversationId = body?.conversationId;
    if (!actor || !conversationId) return { ok: false };

    if (!(await this.messagingService.isMember(conversationId, actor.id))) {
      return { ok: false };
    }
    client.to(conversationRoom(conversationId)).emit(CHAT_EVENTS.TYPING, {
      conversationId,
      userId: actor.id,
      isTyping: body.isTyping !== false,
    });
    return { ok: true };
  }

  // --------------------------------------------------------- server broadcast

  /** Called only after the write has committed (spec 8.23 ordering). */
  emitMessageCreated(message: MessageView): void {
    this.server
      ?.to(conversationRoom(message.conversationId))
      .emit(CHAT_EVENTS.MESSAGE_NEW, message);
  }

  emitMessageUpdated(message: MessageView): void {
    this.server
      ?.to(conversationRoom(message.conversationId))
      .emit(CHAT_EVENTS.MESSAGE_UPDATED, message);
  }

  emitMessageDeleted(message: MessageView): void {
    this.server
      ?.to(conversationRoom(message.conversationId))
      .emit(CHAT_EVENTS.MESSAGE_DELETED, message);
  }

  /**
   * Thread-list refresh. Sent to each participant's personal room so the list
   * updates even when neither side has the thread open.
   */
  emitConversationTouched(userIds: string[], conversationId: string): void {
    for (const userId of userIds) {
      this.server
        ?.to(userRoom(userId))
        .emit(CHAT_EVENTS.CONVERSATION_UPDATED, { conversationId });
    }
  }
}
