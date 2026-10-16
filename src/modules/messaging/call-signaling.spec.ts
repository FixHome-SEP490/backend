import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessagingGateway } from './messaging.gateway';
import { CallRegistryService } from './call-registry.service';
import { CALL_SERVER_EVENTS } from './call.types';
import { MessagingService } from './messaging.service';
import { Role } from '../../shared/enums';

/**
 * These tests are about one thing only: a call must never reach anybody except
 * the two people whose booking it belongs to. The audio path is peer-to-peer
 * and untestable from here, but every decision about *who* is allowed to do
 * *what* happens in the gateway, so that is what is pinned down.
 */

const CUSTOMER = { id: 'c1', role: Role.CUSTOMER };
const TECHNICIAN = { id: 't1', role: Role.TECHNICIAN };
const OUTSIDER = { id: 'x9', role: Role.TECHNICIAN };
const CONVERSATION_ID = 'conv1';

type Emit = { room: string; event: string; payload: Record<string, unknown> };

function makeSocket(user: { id: string; role: Role }, roomEmits?: Emit[]) {
  // `to` mirrors socket.to(room): it reaches the room minus this socket.
  return {
    data: { user },
    to: (room: string) => ({
      emit: (event: string, payload: Record<string, unknown>) => roomEmits?.push({ room: `${room} (except sender)`, event, payload }),
    }),
  } as never;
}

describe('MessagingGateway voice call signalling', () => {
  let gateway: MessagingGateway;
  let registry: CallRegistryService;
  let emits: Emit[];
  /** Conversations the customer and technician share, keyed by id. */
  let peerOf: ReturnType<typeof vi.fn>;
  /** Users with at least one socket connected. */
  let online: Set<string>;
  let notifications: { createNotification: ReturnType<typeof vi.fn> };

  /** Every emit the gateway makes, so we can assert on the destination room. */
  const emitsTo = (room: string) => emits.filter((e) => e.room === room);
  const eventsNamed = (event: string) => emits.filter((e) => e.event === event);

  beforeEach(() => {
    emits = [];
    registry = new CallRegistryService();
    online = new Set([CUSTOMER.id, TECHNICIAN.id, OUTSIDER.id]);
    notifications = { createNotification: vi.fn(async () => ({})) };

    peerOf = vi.fn(async (conversationId: string, userId: string) => {
      if (conversationId !== CONVERSATION_ID) return null;
      if (userId === CUSTOMER.id) return TECHNICIAN.id;
      if (userId === TECHNICIAN.id) return CUSTOMER.id;
      return null;
    });

    gateway = new MessagingGateway(
      { resolveCallPeer: peerOf } as unknown as MessagingService,
      registry,
      {} as never,
      { get: () => undefined, getOrThrow: () => 'secret' } as never,
      { findOne: async ({ where }: { where: { id: string } }) => ({ id: where.id, fullName: where.id === CUSTOMER.id ? 'Khách Một' : 'Thợ Một' }) } as never,
      notifications as never,
    );

    gateway.server = {
      to: (room: string) => ({
        emit: (event: string, payload: Record<string, unknown>) => {
          emits.push({ room, event, payload });
        },
      }),
      in: (room: string) => ({ fetchSockets: async () => (online.has(room.replace('user:', '')) ? [{ id: 'socket' }] : []) }),
    } as never;
  });

  async function placeCall() {
    const result = await gateway.onCallInvite(makeSocket(CUSTOMER), {
      conversationId: CONVERSATION_ID,
    });
    return result.callId as string;
  }

  async function answeredCall() {
    const callId = await placeCall();
    gateway.onCallAccept(makeSocket(TECHNICIAN), { callId });
    emits = [];
    return callId;
  }

  describe('placing a call', () => {
    it('rings the other participant and nobody else', async () => {
      const callId = await placeCall();

      expect(callId).toBeTruthy();
      const incoming = eventsNamed(CALL_SERVER_EVENTS.INCOMING);
      expect(incoming).toHaveLength(1);
      expect(incoming[0].room).toBe(`user:${TECHNICIAN.id}`);
      expect(incoming[0].payload).toMatchObject({
        conversationId: CONVERSATION_ID,
        fromUserId: CUSTOMER.id,
      });
    });

    it('resolves the callee from the database, never from the client', async () => {
      await placeCall();
      // The client only ever sent a conversation id.
      expect(peerOf).toHaveBeenCalledWith(CONVERSATION_ID, CUSTOMER.id);
    });

    it('refuses someone who is not in the conversation', async () => {
      const result = await gateway.onCallInvite(makeSocket(OUTSIDER), {
        conversationId: CONVERSATION_ID,
      });

      expect(result).toEqual({ ok: false, reason: 'forbidden' });
      expect(emits).toHaveLength(0);
    });

    it('refuses a conversation that is no longer active', async () => {
      // A read-only thread resolves to no peer, the same as a missing one.
      peerOf.mockResolvedValue(null);

      const result = await gateway.onCallInvite(makeSocket(CUSTOMER), {
        conversationId: CONVERSATION_ID,
      });

      expect(result).toEqual({ ok: false, reason: 'forbidden' });
      expect(emits).toHaveLength(0);
    });

    it('reports busy rather than starting a second call in the same thread', async () => {
      await placeCall();
      emits = [];

      const second = await gateway.onCallInvite(makeSocket(TECHNICIAN), {
        conversationId: CONVERSATION_ID,
      });

      expect(second).toEqual({ ok: false, reason: 'busy' });
      expect(emits).toHaveLength(0);
    });
  });

  describe('answering', () => {
    it('lets the person being rung pick up and tells the caller', async () => {
      const callId = await placeCall();
      emits = [];

      expect(gateway.onCallAccept(makeSocket(TECHNICIAN), { callId })).toEqual({
        ok: true,
      });
      const accepted = eventsNamed(CALL_SERVER_EVENTS.ACCEPTED);
      expect(accepted).toHaveLength(1);
      expect(accepted[0].room).toBe(`user:${CUSTOMER.id}`);
    });

    it('does not let the caller answer their own call', async () => {
      const callId = await placeCall();
      emits = [];

      expect(gateway.onCallAccept(makeSocket(CUSTOMER), { callId })).toEqual({
        ok: false,
      });
      expect(emits).toHaveLength(0);
    });

    it('does not let a stranger answer a call meant for someone else', async () => {
      const callId = await placeCall();
      emits = [];

      expect(gateway.onCallAccept(makeSocket(OUTSIDER), { callId })).toEqual({
        ok: false,
      });
      expect(emits).toHaveLength(0);
    });

    it('ignores an unknown call id', async () => {
      await placeCall();
      emits = [];

      expect(
        gateway.onCallAccept(makeSocket(TECHNICIAN), { callId: 'made-up' }),
      ).toEqual({ ok: false });
      expect(emits).toHaveLength(0);
    });
  });

  describe('relaying the WebRTC handshake', () => {
    it('forwards the offer only to the other end of the call', async () => {
      const callId = await answeredCall();

      const result = gateway.onCallOffer(makeSocket(CUSTOMER), {
        callId,
        data: { type: 'offer', sdp: 'v=0' },
      });

      expect(result).toEqual({ ok: true });
      expect(emits).toHaveLength(1);
      expect(emits[0].room).toBe(`user:${TECHNICIAN.id}`);
      expect(emits[0].event).toBe(CALL_SERVER_EVENTS.OFFER);
      expect(emits[0].payload.data).toEqual({ type: 'offer', sdp: 'v=0' });
    });

    it('forwards the answer back to the caller', async () => {
      const callId = await answeredCall();

      gateway.onCallAnswer(makeSocket(TECHNICIAN), {
        callId,
        data: { type: 'answer', sdp: 'v=0' },
      });

      expect(emits).toHaveLength(1);
      expect(emits[0].room).toBe(`user:${CUSTOMER.id}`);
      expect(emits[0].event).toBe(CALL_SERVER_EVENTS.ANSWER);
    });

    it('accepts ICE candidates from both sides', async () => {
      const callId = await answeredCall();

      expect(
        gateway.onCallIce(makeSocket(CUSTOMER), { callId, data: { candidate: 'a' } }),
      ).toEqual({ ok: true });
      expect(
        gateway.onCallIce(makeSocket(TECHNICIAN), { callId, data: { candidate: 'b' } }),
      ).toEqual({ ok: true });

      expect(emits.map((e) => e.room)).toEqual([
        `user:${TECHNICIAN.id}`,
        `user:${CUSTOMER.id}`,
      ]);
    });

    it('rejects an offer sent by the wrong side', async () => {
      const callId = await answeredCall();

      // The callee answers, it never offers.
      expect(
        gateway.onCallOffer(makeSocket(TECHNICIAN), { callId, data: {} }),
      ).toEqual({ ok: false });
      expect(emits).toHaveLength(0);
    });

    it('rejects signalling from someone who is not on the call', async () => {
      const callId = await answeredCall();

      expect(gateway.onCallIce(makeSocket(OUTSIDER), { callId, data: {} })).toEqual(
        { ok: false },
      );
      expect(emits).toHaveLength(0);
    });

    it('rejects signalling before the call has been answered', async () => {
      const callId = await placeCall();
      emits = [];

      expect(gateway.onCallOffer(makeSocket(CUSTOMER), { callId, data: {} })).toEqual(
        { ok: false },
      );
      expect(emits).toHaveLength(0);
    });
  });

  describe('hanging up', () => {
    it('tells both sides when the callee declines', async () => {
      const callId = await placeCall();
      emits = [];

      expect(gateway.onCallReject(makeSocket(TECHNICIAN), { callId })).toEqual({
        ok: true,
      });
      const ended = eventsNamed(CALL_SERVER_EVENTS.ENDED);
      expect(ended).toHaveLength(2);
      expect(ended.map((e) => e.room).sort()).toEqual(
        [`user:${CUSTOMER.id}`, `user:${TECHNICIAN.id}`].sort(),
      );
      expect(ended[0].payload.reason).toBe('rejected');
    });

    it('does not let the caller decline on the callee behalf', async () => {
      const callId = await placeCall();
      emits = [];

      expect(gateway.onCallReject(makeSocket(CUSTOMER), { callId })).toEqual({
        ok: false,
      });
      expect(emits).toHaveLength(0);
    });

    it('lets the caller cancel while it is still ringing', async () => {
      const callId = await placeCall();
      emits = [];

      expect(gateway.onCallCancel(makeSocket(CUSTOMER), { callId })).toEqual({
        ok: true,
      });
      expect(eventsNamed(CALL_SERVER_EVENTS.ENDED)[0].payload.reason).toBe(
        'cancelled',
      );
    });

    it('refuses a cancel once the call has been answered', async () => {
      const callId = await answeredCall();

      expect(gateway.onCallCancel(makeSocket(CUSTOMER), { callId })).toEqual({
        ok: false,
      });
      expect(emits).toHaveLength(0);
    });

    it('lets either side end an answered call', async () => {
      const callId = await answeredCall();

      expect(gateway.onCallEnd(makeSocket(TECHNICIAN), { callId })).toEqual({
        ok: true,
      });
      expect(eventsNamed(CALL_SERVER_EVENTS.ENDED)).toHaveLength(2);
    });

    it('frees the thread so a new call can be placed afterwards', async () => {
      const callId = await answeredCall();
      gateway.onCallEnd(makeSocket(CUSTOMER), { callId });
      emits = [];

      const second = await gateway.onCallInvite(makeSocket(CUSTOMER), {
        conversationId: CONVERSATION_ID,
      });

      expect(second.ok).toBe(true);
      expect(second.callId).not.toBe(callId);
    });

    it('ends the call for the peer when the last socket of one side drops', async () => {
      await answeredCall();

      online.delete(CUSTOMER.id);
      await gateway.handleDisconnect(makeSocket(CUSTOMER));

      const ended = eventsNamed(CALL_SERVER_EVENTS.ENDED);
      expect(ended).toHaveLength(1);
      expect(ended[0].room).toBe(`user:${TECHNICIAN.id}`);
      expect(ended[0].payload.reason).toBe('disconnected');
    });

    it('keeps the call alive when the person still has another socket open', async () => {
      await answeredCall();
      gateway.server = {
        ...(gateway.server as unknown as object),
        to: (room: string) => ({
          emit: (event: string, payload: Record<string, unknown>) => {
            emits.push({ room, event, payload });
          },
        }),
        in: () => ({ fetchSockets: async () => [{ id: 'other-tab' }] }),
      } as never;

      await gateway.handleDisconnect(makeSocket(CUSTOMER));

      expect(emits).toHaveLength(0);
      expect(registry.findByUser(CUSTOMER.id)).toBeDefined();
    });
  });

  describe('a second conversation', () => {
    it('cannot be used to reach someone already on another call', async () => {
      await placeCall();
      emits = [];
      // The outsider shares a different thread with the technician.
      peerOf.mockImplementation(async () => TECHNICIAN.id);

      const result = await gateway.onCallInvite(makeSocket(OUTSIDER), {
        conversationId: 'conv2',
      });

      expect(result).toEqual({ ok: false, reason: 'busy' });
      // The busy technician is not rung, only told someone tried.
      const toTechnician = emitsTo(`user:${TECHNICIAN.id}`);
      expect(toTechnician.map((e) => e.event)).toEqual([CALL_SERVER_EVENTS.MISSED]);
      expect(toTechnician[0].payload).toMatchObject({ conversationId: 'conv2', fromUserId: OUTSIDER.id, reason: 'busy' });
      await vi.waitFor(() => expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({
        userId: TECHNICIAN.id, type: 'CALL_MISSED', referenceId: 'conv2', message: expect.stringContaining('lúc bạn đang trong cuộc gọi khác'),
      })));
    });

    it('tells a caller who is already on a call that it is their own line that is busy', async () => {
      await placeCall();
      peerOf.mockImplementation(async () => OUTSIDER.id);

      const result = await gateway.onCallInvite(makeSocket(CUSTOMER), { conversationId: 'conv3' });

      expect(result).toEqual({ ok: false, reason: 'self_busy' });
    });
  });

  describe('a smarter call', () => {
    it('refuses at once when the other person has nothing connected, and leaves a missed call', async () => {
      online.delete(TECHNICIAN.id);

      const result = await gateway.onCallInvite(makeSocket(CUSTOMER), { conversationId: CONVERSATION_ID });

      expect(result).toEqual({ ok: false, reason: 'offline' });
      expect(eventsNamed(CALL_SERVER_EVENTS.INCOMING)).toHaveLength(0);
      expect(registry.findByUser(CUSTOMER.id)).toBeUndefined();
      await vi.waitFor(() => expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({
        userId: TECHNICIAN.id, title: 'Cuộc gọi nhỡ', message: expect.stringContaining('Khách Một đã gọi cho bạn lúc bạn không mở ứng dụng'),
      })));
    });

    it('lets the caller know the callee\'s device is ringing', async () => {
      const callId = await placeCall();
      emits = [];

      expect(gateway.onCallRinging(makeSocket(TECHNICIAN), { callId })).toEqual({ ok: true });

      expect(emits).toEqual([{ room: `user:${CUSTOMER.id}`, event: CALL_SERVER_EVENTS.RINGING, payload: { callId, conversationId: CONVERSATION_ID } }]);
    });

    it('accepts the ringing signal only from the person being rung, and only while it rings', async () => {
      const callId = await placeCall();
      expect(gateway.onCallRinging(makeSocket(CUSTOMER), { callId })).toEqual({ ok: false });
      expect(gateway.onCallRinging(makeSocket(OUTSIDER), { callId })).toEqual({ ok: false });
      gateway.onCallAccept(makeSocket(TECHNICIAN), { callId });
      expect(gateway.onCallRinging(makeSocket(TECHNICIAN), { callId })).toEqual({ ok: false });
    });

    it('stops the ringing on the callee\'s other devices once one of them picks up', async () => {
      const callId = await placeCall();
      const roomEmits: Emit[] = [];

      gateway.onCallAccept(makeSocket(TECHNICIAN, roomEmits), { callId });

      expect(roomEmits).toEqual([{ room: `user:${TECHNICIAN.id} (except sender)`, event: CALL_SERVER_EVENTS.ENDED, payload: { callId, conversationId: CONVERSATION_ID, reason: 'answered_elsewhere' } }]);
    });

    it('leaves a missed call when the caller gives up while it rings', async () => {
      const callId = await placeCall();

      gateway.onCallCancel(makeSocket(CUSTOMER), { callId });

      await vi.waitFor(() => expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({
        userId: TECHNICIAN.id, type: 'CALL_MISSED', referenceType: 'conversation', referenceId: CONVERSATION_ID,
      })));
    });

    it('leaves a missed call when nobody picks up in time', async () => {
      vi.useFakeTimers();
      try {
        await placeCall();
        vi.advanceTimersByTime(45_000);
        expect(eventsNamed(CALL_SERVER_EVENTS.ENDED).map((e) => e.payload.reason)).toEqual(['timeout', 'timeout']);
        await vi.waitFor(() => expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: TECHNICIAN.id, type: 'CALL_MISSED' })));
      } finally {
        vi.useRealTimers();
      }
    });

    it('a declined or finished call is not a missed call', async () => {
      const callId = await placeCall();
      gateway.onCallReject(makeSocket(TECHNICIAN), { callId });
      const second = await placeCall();
      gateway.onCallAccept(makeSocket(TECHNICIAN), { callId: second });
      gateway.onCallEnd(makeSocket(CUSTOMER), { callId: second });
      await new Promise((r) => setTimeout(r, 0));
      expect(notifications.createNotification).not.toHaveBeenCalled();
    });

    it('a failing notification never breaks the call signalling', async () => {
      notifications.createNotification.mockRejectedValueOnce(new Error('db down'));
      online.delete(TECHNICIAN.id);
      await expect(gateway.onCallInvite(makeSocket(CUSTOMER), { conversationId: CONVERSATION_ID })).resolves.toEqual({ ok: false, reason: 'offline' });
    });
  });
});
