// src/modules/messaging/messaging.controller.ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiBearerAuth, ApiConsumes, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { VIDEO_MAX_BYTES } from '../../shared/utils/media-signature';
import type { ChatAttachmentFile } from './chat-attachment-storage.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { MessagingService } from './messaging.service';
import { MessagingGateway } from './messaging.gateway';
import {
  EditMessageDto,
  ListMessagesQueryDto,
  SendAttachmentDto,
  SendMessageDto,
} from './messaging.dto';

type RequestUser = { user: { id: string; role: string } };

/**
 * REST owns history; the gateway owns the live push. A screen loads the thread
 * over REST and then only receives deltas, so a dropped socket degrades to a
 * refresh instead of a hole in the conversation.
 */
@ApiTags('Messaging')
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly messagingService: MessagingService,
    private readonly gateway: MessagingGateway,
  ) {}

  @Get()
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('message:read_thread')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List my booking conversations, newest activity first' })
  async listMine(@Req() req: RequestUser) {
    const data = await this.messagingService.listMyConversations(req.user);
    return { data };
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('message:read_thread')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get one conversation' })
  async getOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestUser,
  ) {
    const data = await this.messagingService.getConversation(id, req.user);
    return { data };
  }

  @Get(':id/messages')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('message:read_thread')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Page through thread history (keyset, newest page first)' })
  async listMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListMessagesQueryDto,
    @Req() req: RequestUser,
  ) {
    const result = await this.messagingService.listMessages(
      id,
      req.user,
      query,
    );
    return { data: result.data, meta: { nextBefore: result.nextBefore } };
  }

  @Post(':id/messages')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('message:write_thread')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send a message to this booking conversation' })
  async send(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendMessageDto,
    @Req() req: RequestUser,
  ) {
    const { message } = await this.messagingService.sendMessage(
      id,
      req.user,
      body,
    );
    // Persisted and committed before anything is broadcast (spec 8.23).
    this.gateway.emitMessageCreated(message);
    this.gateway.emitConversationTouched(
      await this.messagingService.participantIds(id),
      id,
    );
    return { data: message };
  }

  @Post(':id/attachments')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('message:write_thread')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: VIDEO_MAX_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Send a photo (jpeg/png/webp, 10 MB) or a short video (mp4/mov/webm, 50 MB) with an optional caption' })
  async sendAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SendAttachmentDto,
    @Req() req: RequestUser,
    @UploadedFile() file?: ChatAttachmentFile,
  ) {
    const { message } = await this.messagingService.sendAttachment(id, req.user, body, file);
    this.gateway.emitMessageCreated(message);
    this.gateway.emitConversationTouched(
      await this.messagingService.participantIds(id),
      id,
    );
    return { data: message };
  }

  @Post(':id/read')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('message:read_thread')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mark this conversation as read up to now' })
  async markRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestUser,
  ) {
    const data = await this.messagingService.markRead(id, req.user);
    return { data };
  }
}

@ApiTags('Messaging')
@Controller('messages')
export class MessagesController {
  constructor(
    private readonly messagingService: MessagingService,
    private readonly gateway: MessagingGateway,
  ) {}

  @Patch(':id')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('message:write_thread')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edit my own message' })
  async edit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EditMessageDto,
    @Req() req: RequestUser,
  ) {
    const { message, conversation } = await this.messagingService.editMessage(
      id,
      req.user,
      body,
    );
    this.gateway.emitMessageUpdated(message);
    this.gateway.emitConversationTouched(
      [conversation.customerId, conversation.technicianId],
      conversation.id,
    );
    return { data: message };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('message:write_thread')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Retract my own message' })
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestUser,
  ) {
    const { message, conversation } = await this.messagingService.deleteMessage(
      id,
      req.user,
    );
    this.gateway.emitMessageDeleted(message);
    this.gateway.emitConversationTouched(
      [conversation.customerId, conversation.technicianId],
      conversation.id,
    );
    return { data: message };
  }

  @Get(':id/attachment')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('message:read_thread')
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'The photo or video sent with this message',
    content: {
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/webp': { schema: { type: 'string', format: 'binary' } },
      'video/mp4': { schema: { type: 'string', format: 'binary' } },
      'video/quicktime': { schema: { type: 'string', format: 'binary' } },
      'video/webm': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: 'Read the photo or video of a message in a thread I can read' })
  async attachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestUser,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const content = await this.messagingService.attachmentContent(id, req.user);
    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', content.mimeType);
    response.setHeader('Content-Length', String(content.buffer.length));
    response.end(content.buffer);
  }
}
