// src/modules/messaging/messaging.module.ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Conversation } from './entities/conversation.entity';
import { Message } from './entities/message.entity';
import { User } from '../users/entities/user.entity';
import { MessagingService } from './messaging.service';
import { MessagingGateway } from './messaging.gateway';
import { CallRegistryService } from './call-registry.service';
import { AcceptGreetingPublisher } from './accept-greeting.publisher';
import { ChatAttachmentStorage } from './chat-attachment-storage.service';
import { OrderRealtimeSubscriber } from './order-realtime.subscriber';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  ConversationsController,
  MessagesController,
} from './messaging.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message, User]),
    NotificationsModule,
    // Same access secret as the HTTP guard: one identity, two transports.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
  ],
  controllers: [ConversationsController, MessagesController],
  providers: [MessagingService, CallRegistryService, MessagingGateway, AcceptGreetingPublisher, ChatAttachmentStorage, OrderRealtimeSubscriber],
  exports: [MessagingService, MessagingGateway, AcceptGreetingPublisher, OrderRealtimeSubscriber],
})
export class MessagingModule {}
