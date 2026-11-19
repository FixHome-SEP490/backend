import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  NotFoundException,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PageLimitQueryDto } from '../../shared/dto/page-size-query.dto';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import { PaginationMeta } from '../../shared/dto/api-response.dto';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { BroadcastNotificationDto } from './dto/broadcast-notification.dto';
import { CurrentUser } from '../../common/decorators';
import { User } from '../users/entities/user.entity';
import { AuditLogService } from '../audit-log/audit-log.service';

@ApiTags('Notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notificationsService: NotificationsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get user notifications' })
  async getMyNotifications(
    @Req() req: { user: { id: string } },
    @Query() query: PageLimitQueryDto,
  ): Promise<{
    data: Awaited<ReturnType<NotificationsService['getMyNotifications']>>['data'];
    meta: PaginationMeta;
  }> {
    const p = query.page;
    const l = query.limit;
    const result = await this.notificationsService.getMyNotifications(req.user.id, p, l);
    return {
      data: result.data,
      meta: {
        page: p,
        limit: l,
        total: result.total,
        totalPages: Math.ceil(result.total / l),
      },
    };
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Get unread notifications count' })
  async getUnreadCount(@Req() req: { user: { id: string } }) {
    return this.notificationsService.getUnreadCount(req.user.id);
  }

  @Post()
  @UseGuards(RolesGuard)
  // Technicians used to be allowed here, which let any technician push a
  // notification with any title to any user id (a phishing channel). The
  // system notifications technicians cause are created server side.
  @Roles(Role.ADMIN, Role.SERVICE_MANAGER)
  @ApiOperation({ summary: 'Send notification to a user (Admin, SM)' })
  async sendNotification(
    @Body() body: CreateNotificationDto,
  ) {
    return this.notificationsService.createNotification(body);
  }

  @Post('broadcast')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Admin: send one notification to every active user of an audience' })
  async broadcast(@Body() body: BroadcastNotificationDto, @CurrentUser() user: User) {
    const audience = body.audience ?? 'all';
    const result = await this.notificationsService.broadcast({ title: body.title, message: body.message, audience });
    await this.auditLogService.log({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'NOTIFICATION_BROADCAST',
      resourceType: 'NOTIFICATION',
      after: { audience, title: body.title, recipients: result.recipients },
    });
    return result;
  }

  @Get('broadcasts')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Admin: broadcasts sent, newest first, with how many were read' })
  async listBroadcasts() {
    return this.notificationsService.listBroadcasts();
  }

  @Delete('broadcasts/:key')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Admin: recall one broadcast for every recipient' })
  async recallBroadcast(@Param('key') key: string, @CurrentUser() user: User) {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/.test(key)) {
      throw new NotFoundException('Không tìm thấy thông báo này.');
    }
    const result = await this.notificationsService.recallBroadcast(key);
    if (!result.recalled) throw new NotFoundException('Thông báo này đã được thu hồi hoặc không tồn tại.');
    await this.auditLogService.log({
      actorUserId: user.id,
      actorRole: user.role,
      action: 'NOTIFICATION_BROADCAST_RECALLED',
      resourceType: 'NOTIFICATION',
      after: { sentAt: key, title: result.title, recalled: result.recalled },
    });
    return result;
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  async markAsRead(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string } },
  ) {
    return this.notificationsService.markAsRead(id, req.user.id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllAsRead(@Req() req: { user: { id: string } }) {
    return this.notificationsService.markAllAsRead(req.user.id);
  }
}
