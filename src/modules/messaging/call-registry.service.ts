// src/modules/messaging/call-registry.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CallSession } from './call.types';

/** A call nobody answers stops ringing by itself. */
export const RINGING_TIMEOUT_MS = 45_000;

/**
 * In-memory bookkeeping for calls that are happening right now.
 *
 * Deliberately not a database table: a call has no meaning once it is over, and
 * the feature is explicitly scoped to peer-to-peer audio with no history. A
 * server restart therefore drops every in-flight call, which is correct — the
 * media connection dies with it anyway.
 *
 * Two invariants are enforced here rather than in the gateway, because they are
 * what stops one person's call leaking into another's:
 *  - one live call per conversation, so an invite cannot race a second invite;
 *  - one live call per person, so being in a call makes you busy everywhere.
 */
@Injectable()
export class CallRegistryService {
  private readonly logger = new Logger(CallRegistryService.name);

  private readonly calls = new Map<string, CallSession>();
  private readonly byConversation = new Map<string, string>();
  /** userId -> callId, for both participants. */
  private readonly byUser = new Map<string, string>();
  private readonly ringingTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Returns the new session, or the id of whichever party is already busy so
   * the caller can be told exactly who is unavailable.
   */
  create(
    conversationId: string,
    callerId: string,
    calleeId: string,
    onRingingTimeout: (call: CallSession) => void,
  ): { call: CallSession } | { busyUserId: string } {
    if (this.byConversation.has(conversationId)) {
      return { busyUserId: callerId };
    }
    const busy = this.byUser.has(callerId)
      ? callerId
      : this.byUser.has(calleeId)
        ? calleeId
        : null;
    if (busy) return { busyUserId: busy };

    const call: CallSession = {
      id: randomUUID(),
      conversationId,
      callerId,
      calleeId,
      state: 'ringing',
      createdAt: Date.now(),
    };

    this.calls.set(call.id, call);
    this.byConversation.set(conversationId, call.id);
    this.byUser.set(callerId, call.id);
    this.byUser.set(calleeId, call.id);

    const timer = setTimeout(() => {
      const expired = this.remove(call.id);
      if (expired) onRingingTimeout(expired);
    }, RINGING_TIMEOUT_MS);
    // Do not keep the process (or a Jest worker) alive just for a ringtone.
    timer.unref?.();
    this.ringingTimers.set(call.id, timer);

    return { call };
  }

  get(callId: string): CallSession | undefined {
    return this.calls.get(callId);
  }

  /** Only the two people on the call may act on it. */
  isParticipant(call: CallSession, userId: string): boolean {
    return call.callerId === userId || call.calleeId === userId;
  }

  peerOf(call: CallSession, userId: string): string {
    return call.callerId === userId ? call.calleeId : call.callerId;
  }

  /** Picking up stops the ringing timeout; from here the call lasts until a hang-up. */
  markConnected(callId: string): CallSession | undefined {
    const call = this.calls.get(callId);
    if (!call || call.state !== 'ringing') return undefined;
    this.clearTimer(callId);
    call.state = 'connected';
    return call;
  }

  remove(callId: string): CallSession | undefined {
    const call = this.calls.get(callId);
    if (!call) return undefined;
    this.clearTimer(callId);
    this.calls.delete(callId);
    this.byConversation.delete(call.conversationId);
    // Guard against clobbering a newer call the user may already have joined.
    if (this.byUser.get(call.callerId) === callId) {
      this.byUser.delete(call.callerId);
    }
    if (this.byUser.get(call.calleeId) === callId) {
      this.byUser.delete(call.calleeId);
    }
    this.logger.debug(`Call ${callId} closed after ${Date.now() - call.createdAt}ms`);
    return call;
  }

  /** A dropped socket must not leave the other side staring at a dead call. */
  findByUser(userId: string): CallSession | undefined {
    const callId = this.byUser.get(userId);
    return callId ? this.calls.get(callId) : undefined;
  }

  private clearTimer(callId: string): void {
    const timer = this.ringingTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.ringingTimers.delete(callId);
    }
  }
}
