// src/modules/messaging/call.types.ts

/**
 * Voice call signalling contract, shared by the gateway, the registry and the
 * clients.
 *
 * Scope note: calls are peer-to-peer over WebRTC and are deliberately *not*
 * persisted. A call only exists while it is happening, so the server keeps its
 * state in memory and forgets it the moment the call ends. The one thing that
 * outlives a call is a missed call: it becomes a notification for the person
 * who was rung, so a call nobody saw is not lost.
 */

/** Events the client sends to the server. */
export const CALL_CLIENT_EVENTS = {
  /** Start ringing the other participant of a conversation. */
  INVITE: 'call:invite',
  /** The callee's device is showing the call (it rings there). */
  RINGING: 'call:ringing',
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
  /** The callee's device is ringing — the caller hears the ringback tone. */
  RINGING: 'call:ringing',
  /** Your callee picked up — the caller now creates the offer. */
  ACCEPTED: 'call:accepted',
  /** Someone tried to call you and could not get through (you were busy). */
  MISSED: 'call:missed',
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
  | 'busy'
  /** Picked up on another of the callee's devices; this one just stops ringing. */
  | 'answered_elsewhere';

/** Why the server would not ring anyone. */
export type CallInviteRefusal =
  | 'invalid'
  | 'forbidden'
  /** The other person is in another call. */
  | 'busy'
  /** You are already in a call yourself. */
  | 'self_busy'
  /** The other person has no device connected, so nothing can ring. */
  | 'offline';

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
