// src/modules/messaging/call.types.ts

/**
 * Voice call signalling contract, shared by the gateway, the registry and the
 * clients.
 *
 * Scope note: calls are peer-to-peer over WebRTC and are deliberately *not*
 * persisted. A call only exists while it is happening, so the server keeps its
 * state in memory and forgets it the moment the call ends. Nothing here writes
 * to the database.
 */

/** Events the client sends to the server. */
export const CALL_CLIENT_EVENTS = {
  /** Start ringing the other participant of a conversation. */
  INVITE: 'call:invite',
  /** Callee picks up. */
  ACCEPT: 'call:accept',
  /** Callee declines. */
  REJECT: 'call:reject',
  /** Caller hangs up before the callee picked up. */
  CANCEL: 'call:cancel',
  /** Either side hangs up an answered call. */
  END: 'call:end',
  /** WebRTC session description from the caller. */
  OFFER: 'call:offer',
  /** WebRTC session description from the callee. */
  ANSWER: 'call:answer',
  /** A single ICE candidate, relayed verbatim. */
  ICE: 'call:ice',
} as const;

/** Events the server pushes to the clients. */
export const CALL_SERVER_EVENTS = {
  /** Someone is calling you. */
  INCOMING: 'call:incoming',
  /** Your callee picked up — the caller now creates the offer. */
  ACCEPTED: 'call:accepted',
  /** The call is over, for whatever reason. */
  ENDED: 'call:ended',
  OFFER: 'call:offer',
  ANSWER: 'call:answer',
  ICE: 'call:ice',
} as const;

/** Why a call stopped. Rendered as Vietnamese text by the clients. */
export type CallEndReason =
  | 'rejected'
  | 'cancelled'
  | 'ended'
  | 'timeout'
  | 'disconnected'
  | 'busy';

export type CallState = 'ringing' | 'connected';

export interface CallSession {
  id: string;
  conversationId: string;
  callerId: string;
  calleeId: string;
  state: CallState;
  /** Epoch milliseconds, used only for logging and for the ringing timeout. */
  createdAt: number;
}

/** A caller-supplied payload is never inspected, only forwarded to the peer. */
export interface CallSignalPayload {
  callId?: string;
  /** RTCSessionDescriptionInit or RTCIceCandidateInit, passed straight through. */
  data?: unknown;
}
