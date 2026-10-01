// src/modules/messaging/accept-greeting.publisher.ts
import { Injectable, Logger } from '@nestjs/common';
import { MessagingService } from './messaging.service';
import { MessagingGateway } from './messaging.gateway';

/**
 * Sends the technician's automatic first message once an accept (or a staff
 * assignment) has committed, then publishes it like any other message.
 *
 * Best effort by design: the job is already the technician's, and a greeting
 * that cannot be written must never turn that into an error.
 */
@Injectable()
export class AcceptGreetingPublisher {
  private readonly logger = new Logger(AcceptGreetingPublisher.name);

  constructor(
    private readonly messagingService: MessagingService,
    private readonly gateway: MessagingGateway,
  ) {}

  async send(params: {
    bookingId: string;
    technicianId: string;
    serviceOrderId: string;
    orderCode: string;
  }): Promise<void> {
    try {
      const message = await this.messagingService.postAcceptGreeting(params);
      if (!message) return;
      this.gateway.emitMessageCreated(message);
      this.gateway.emitConversationTouched(
        await this.messagingService.participantIds(message.conversationId),
        message.conversationId,
      );
    } catch (error) {
      this.logger.warn(`Accept greeting not sent for order ${params.serviceOrderId}: ${(error as Error).message}`);
    }
  }
}
