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
import {
  ConversationsController,
  MessagesController,
} from './messaging.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message, User]),
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
  providers: [MessagingService, MessagingGateway],
  exports: [MessagingService, MessagingGateway],
})
export class MessagingModule {}
