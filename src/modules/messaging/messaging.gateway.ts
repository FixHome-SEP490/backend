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
import { CallRegistryService } from './call-registry.service';
import {
  CALL_CLIENT_EVENTS,
  CALL_SERVER_EVENTS,
  CallEndReason,
  CallSession,
  CallSignalPayload,
} from './call.types';

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

const DEFAULT_ICE_URLS = 'stun:stun.l.google.com:19302';

const conversationRoom = (conversationId: string) => `conversation:${conversationId}`;
const userRoom = (userId: string) => `user:${userId}`;

/** Which side of a call is allowed to send a given signal. */
type SignalSender = 'caller' | 'callee' | 'either';

/**
 * Realtime transport for booking-scoped chat (spec 8.23: WebSocket is the
 * transport, persistence is the source of truth).
 *
 * Every socket is authenticated from its own JWT before it joins anything, and
 * room membership is resolved from the database. The client never tells the
 * server who it is, so a message cannot be delivered to the wrong person.
 *
 * The same socket also carries voice-call signalling. Only the handshake
 * messages travel through here; the audio itself goes peer-to-peer and never
 * reaches this server.
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
    private readonly callRegistry: CallRegistryService,
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

    // The ICE configuration rides along so the client needs no extra request
    // before it can place a call.
    client.emit('connect:ready', {
      userId: actor.id,
      conversationIds,
      iceServers: this.iceServers(),
    });
  }

  async handleDisconnect(client: ChatSocket): Promise<void> {
    const userId = client.data?.user?.id;
    if (!userId) return;

    this.logger.debug(`Chat socket disconnected for user ${userId}`);

    const call = this.callRegistry.findByUser(userId);
    if (!call) return;

    // One person may have several sockets open (a second tab, or the phone as
    // well as the laptop). Losing one of them is not losing the call, so only
    // hang up once nothing of theirs is left connected.
    if (await this.hasLiveSocket(userId)) return;

    this.callRegistry.remove(call.id);
    this.notifyCallEnded(call, 'disconnected', [
      this.callRegistry.peerOf(call, userId),
    ]);
  }

  private async hasLiveSocket(userId: string): Promise<boolean> {
    try {
      const sockets = await this.server?.in(userRoom(userId)).fetchSockets();
      return (sockets?.length ?? 0) > 0;
    } catch {
      // If we cannot tell, assume they are gone rather than leave the other
      // side listening to a call that no longer has two ends.
      return false;
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

  /**
   * STUN only, and optional at that. On a single Wi-Fi network both peers
   * already know an address the other can reach, so an empty list still
   * connects. Set WEBRTC_ICE_URLS to an empty string to switch STUN off
   * entirely, or to a TURN url list if the deployment ever leaves the LAN.
   */
  private iceServers(): { urls: string[] }[] {
    const raw =
      this.configService.get<string>('WEBRTC_ICE_URLS') ?? DEFAULT_ICE_URLS;
    const urls = raw
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean);
    return urls.length > 0 ? [{ urls }] : [];
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

  // -------------------------------------------------------- voice call events

  /**
   * Ring the other participant.
   *
   * The client sends only a conversation id. Who gets rung is resolved from the
   * database, which is what makes it impossible to call someone you are not in
   * a booking with, or to be rung by a stranger.
   */
  @SubscribeMessage(CALL_CLIENT_EVENTS.INVITE)
  async onCallInvite(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { conversationId?: string },
  ): Promise<{ ok: boolean; callId?: string; reason?: string }> {
    const actor = client.data?.user;
    const conversationId = body?.conversationId;
    if (!actor || !conversationId) return { ok: false, reason: 'invalid' };

    const peerId = await this.messagingService.resolveCallPeer(
      conversationId,
      actor.id,
    );
    if (!peerId) return { ok: false, reason: 'forbidden' };

    const created = this.callRegistry.create(
      conversationId,
      actor.id,
      peerId,
      (expired) =>
        this.notifyCallEnded(expired, 'timeout', [
          expired.callerId,
          expired.calleeId,
        ]),
    );
    if ('busyUserId' in created) return { ok: false, reason: 'busy' };

    const { call } = created;
    // Sent to the personal room, not the conversation room, so it reaches the
    // callee on every device even when they have no thread open.
    this.server?.to(userRoom(peerId)).emit(CALL_SERVER_EVENTS.INCOMING, {
      callId: call.id,
      conversationId,
      fromUserId: actor.id,
    });
    return { ok: true, callId: call.id };
  }

  /** Pick up. Only the person being rung can do this. */
  @SubscribeMessage(CALL_CLIENT_EVENTS.ACCEPT)
  onCallAccept(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { callId?: string },
  ): { ok: boolean } {
    const actor = client.data?.user;
    const call = body?.callId ? this.callRegistry.get(body.callId) : undefined;
    if (!actor || !call || call.calleeId !== actor.id) return { ok: false };

    if (!this.callRegistry.markConnected(call.id)) return { ok: false };

    // The caller creates the offer, so it is told the moment someone picks up.
    this.server?.to(userRoom(call.callerId)).emit(CALL_SERVER_EVENTS.ACCEPTED, {
      callId: call.id,
      conversationId: call.conversationId,
    });
    return { ok: true };
  }

  /** Decline a call that is still ringing. */
  @SubscribeMessage(CALL_CLIENT_EVENTS.REJECT)
  onCallReject(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { callId?: string },
  ): { ok: boolean } {
    return this.hangUp(
      client,
      body?.callId,
      'rejected',
      (call, userId) => call.calleeId === userId && call.state === 'ringing',
    );
  }

  /** Give up before the other side picked up. */
  @SubscribeMessage(CALL_CLIENT_EVENTS.CANCEL)
  onCallCancel(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { callId?: string },
  ): { ok: boolean } {
    return this.hangUp(
      client,
      body?.callId,
      'cancelled',
      (call, userId) => call.callerId === userId && call.state === 'ringing',
    );
  }

  /** Hang up an answered call. Either side may. */
  @SubscribeMessage(CALL_CLIENT_EVENTS.END)
  onCallEnd(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: { callId?: string },
  ): { ok: boolean } {
    return this.hangUp(client, body?.callId, 'ended', (call, userId) =>
      this.callRegistry.isParticipant(call, userId),
    );
  }

  /** The caller's session description, forwarded untouched. */
  @SubscribeMessage(CALL_CLIENT_EVENTS.OFFER)
  onCallOffer(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: CallSignalPayload,
  ): { ok: boolean } {
    return this.relaySignal(client, body, CALL_SERVER_EVENTS.OFFER, 'caller');
  }

  /** The callee's answer. */
  @SubscribeMessage(CALL_CLIENT_EVENTS.ANSWER)
  onCallAnswer(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: CallSignalPayload,
  ): { ok: boolean } {
    return this.relaySignal(client, body, CALL_SERVER_EVENTS.ANSWER, 'callee');
  }

  /** A trickled ICE candidate; both sides send these throughout the call. */
  @SubscribeMessage(CALL_CLIENT_EVENTS.ICE)
  onCallIce(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: CallSignalPayload,
  ): { ok: boolean } {
    return this.relaySignal(client, body, CALL_SERVER_EVENTS.ICE, 'either');
  }

  // ----------------------------------------------------------- call plumbing

  /**
   * Shared hang-up path. Both parties are told, including the one who hung up,
   * so neither client has to guess whether its own request landed.
   */
  private hangUp(
    client: ChatSocket,
    callId: string | undefined,
    reason: CallEndReason,
    allowed: (call: CallSession, userId: string) => boolean,
  ): { ok: boolean } {
    const actor = client.data?.user;
    const call = callId ? this.callRegistry.get(callId) : undefined;
    if (!actor || !call || !allowed(call, actor.id)) return { ok: false };

    this.callRegistry.remove(call.id);
    this.notifyCallEnded(call, reason, [call.callerId, call.calleeId]);
    return { ok: true };
  }

  /**
   * Forward one WebRTC handshake message to the other end of the call.
   *
   * The payload is never parsed - it is opaque browser data. What is checked is
   * everything around it: the call exists, it has been answered, the sender is
   * on it, and the sender is on the side that is supposed to send this kind of
   * message. The destination is derived from the stored session, so a client
   * cannot aim a signal at anyone else.
   */
  private relaySignal(
    client: ChatSocket,
    body: CallSignalPayload,
    event: string,
    expected: SignalSender,
  ): { ok: boolean } {
    const actor = client.data?.user;
    const call = body?.callId ? this.callRegistry.get(body.callId) : undefined;
    if (!actor || !call) return { ok: false };
    if (call.state !== 'connected') return { ok: false };
    if (!this.callRegistry.isParticipant(call, actor.id)) return { ok: false };

    if (expected === 'caller' && call.callerId !== actor.id) return { ok: false };
    if (expected === 'callee' && call.calleeId !== actor.id) return { ok: false };

    this.server
      ?.to(userRoom(this.callRegistry.peerOf(call, actor.id)))
      .emit(event, { callId: call.id, data: body.data });
    return { ok: true };
  }

  private notifyCallEnded(
    call: CallSession,
    reason: CallEndReason,
    userIds: string[],
  ): void {
    for (const userId of userIds) {
      this.server?.to(userRoom(userId)).emit(CALL_SERVER_EVENTS.ENDED, {
        callId: call.id,
        conversationId: call.conversationId,
        reason,
      });
    }
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
