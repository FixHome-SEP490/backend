// src/modules/bookings/bookings.controller.ts
import {
  Controller,
  ParseUUIDPipe,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiOkResponse } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { BookingsService } from './bookings.service';
import { InvitationsService } from './invitations.service';
import { AttachBookingMediaDto, CreateBookingDto, ScheduleBookingDto, RebookDto, ShortlistDto } from './booking.dto';
import { ReasonDto } from '../service-orders/order-command.dto';
import { BookingStatus } from '../../shared/enums';
import { toBookingInvitationResponse, toBookingMediaResponse, toBookingResponse } from './booking-privacy.dto';
import { BookingPrivateMediaContentService } from './booking-private-media-content.service';

@ApiTags('Bookings')
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookingsService: BookingsService,
    private readonly invitationsService: InvitationsService,
    private readonly privateMediaContentService: BookingPrivateMediaContentService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Customer: create a Booking', description: 'Send catalog serviceId, saved addressId, description and ISO 8601 arrival window. photoUploadIds are optional PHOTO IDs, not technician IDs. Creates a submitted Booking, not a ServiceOrder or payment.' })
  async create(@Body() dto: CreateBookingDto, @Req() req: { user: { id: string; role: string } }) {
    const booking = await this.bookingsService.create(dto, req.user);
    return { data: toBookingResponse(booking) };
  }

  @Get('my')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:read_own')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List my bookings' })
  async findMy(
    @Req() req: { user: { id: string } },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: BookingStatus,
  ) {
    const result = await this.bookingsService.findMyBookings(req.user.id, {
      page: page ? parseInt(page, 10) : 1,
      limit: pageSize ? parseInt(pageSize, 10) : 20,
      status,
    });
    return { data: result.data.map(toBookingResponse), meta: { total: result.total } };
  }

  @Get()
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:read_all')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all bookings (SM / Admin board)' })
  async findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: BookingStatus,
  ) {
    const result = await this.bookingsService.findAllForStaff({
      page: page ? parseInt(page, 10) : 1,
      limit: pageSize ? parseInt(pageSize, 10) : 20,
      status,
    });
    return { data: result.data.map(toBookingResponse), meta: { total: result.total } };
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get booking by ID' })
  async findById(@Param('id', ParseUUIDPipe) id: string, @Req() req: { user: { id: string; role: string } }) {
    await this.bookingsService.findById(id, req.user);
    await this.invitationsService.refreshMatching(id);
    const booking = await this.bookingsService.findById(id, req.user);
    return { data: toBookingResponse(booking) };
  }

  @Get(':bookingId/media/:mediaId/content')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOkResponse({
    description: 'Validated private Booking photo bytes',
    content: {
      'image/jpeg': { schema: { type: 'string', format: 'binary' } },
      'image/png': { schema: { type: 'string', format: 'binary' } },
      'image/webp': { schema: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: 'Read private Booking photo content' })
  async getPrivateMediaContent(
    @Param('bookingId', ParseUUIDPipe) bookingId: string,
    @Param('mediaId', ParseUUIDPipe) mediaId: string,
    @Req() req: { user: { id: string; role: string } },
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'private, no-store, max-age=0');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const content = await this.privateMediaContentService.download(bookingId, mediaId, req.user);
    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', content.mimeType);
    response.setHeader('Content-Length', String(content.buffer.length));
    response.end(content.buffer);
  }

  @Post(':id/media')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Attach media to booking' })
  async attachMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AttachBookingMediaDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const media = await this.bookingsService.attachMedia(id, body, req.user);
    return { data: toBookingMediaResponse(media) };
  }

  @Get(':id/technician-candidates')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('invitation:shortlist')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get technician candidates for a booking' })
  async getCandidates(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const candidates = await this.bookingsService.getCandidates(id, req.user);
    return { data: candidates };
  }

  @Post(':id/shortlist')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('invitation:shortlist')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Customer: invite one or two technicians in priority order',
    description: 'Send one or two distinct Technician User IDs in customer-selected order. The first eligible technician is invited immediately. When a second technician is selected, that technician remains STANDBY and cannot see or accept this Booking until the first declines or expires. This creates invitations, not a ServiceOrder.',
  })
  async createShortlist(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ShortlistDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const invitations = await this.invitationsService.createShortlist(
      id,
      body.technicianIds,
      req.user,
    );
    return { data: invitations.map(toBookingInvitationResponse) };
  }

  @Post(':id/matching/extend')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm one TTL extension for the live invitation group' })
  async extendMatching(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const extension = await this.invitationsService.extendPendingInvitationGroup(id, req.user);
    return { data: extension };
  }

  @Patch(':id/schedule')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Customer: adjust pre-accept Booking schedule or description', description: 'Use preferredStartAt/preferredEndAt and optional description. An unchanged arrival window with description-only edits retains the invitation round; an actual time change before Accept can reset matching. Matched/linked ServiceOrder is not freely editable.' })
  async reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ScheduleBookingDto,
    @Req() req: { user: { id: string } },
  ) {
    const booking = await this.bookingsService.reschedule(id, body, req.user);
    return { data: toBookingResponse(booking) };
  }

  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  async cancelBooking(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto, @Req() req: { user: { id: string } }) {
    return { data: toBookingResponse(await this.bookingsService.cancelBooking(id, body.reason, req.user)) };
  }

  @Post(':id/rebook')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Spec v1.4 D1-20: Rebook from a historical booking (creates a new Booking)' })
  async rebook(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: RebookDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const newBooking = await this.bookingsService.rebook(id, req.user, body);
    return { data: toBookingResponse(newBooking) };
  }
}
