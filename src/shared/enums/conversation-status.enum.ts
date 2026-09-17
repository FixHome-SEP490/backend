// src/shared/enums/conversation-status.enum.ts
// Spec 8.6 / CHAT-BR-01: a conversation is always bound to a Booking and one
// invited Technician. When the Booking is assigned, the winning conversation
// stays ACTIVE and every other conversation of that Booking becomes READ_ONLY.
export enum ConversationStatus {
  ACTIVE = 'active',
  READ_ONLY = 'read_only',
  CLOSED = 'closed',
}
