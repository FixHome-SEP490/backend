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
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { BookingsService } from './bookings.service';
import { InvitationsService } from './invitations.service';
import { CreateBookingDto, ScheduleBookingDto, RebookDto, ShortlistDto } from './booking.dto';
import { ReasonDto } from '../service-orders/order-command.dto';
import { BookingStatus } from '../../shared/enums';

@ApiTags('Bookings')
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookingsService: BookingsService,
    private readonly invitationsService: InvitationsService,
  ) {}

  @Post()
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new booking' })
  async create(@Body() dto: CreateBookingDto, @Req() req: { user: { id: string; role: string } }) {
    const booking = await this.bookingsService.create(dto, req.user);
    return { data: booking };
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
    return { data: result.data, meta: { total: result.total } };
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
    return { data: result.data, meta: { total: result.total } };
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get booking by ID' })
  async findById(@Param('id', ParseUUIDPipe) id: string, @Req() req: { user: { id: string; role: string } }) {
    await this.bookingsService.findById(id, req.user);
    await this.invitationsService.refreshMatching(id);
    const booking = await this.bookingsService.findById(id, req.user);
    return { data: booking };
  }

  @Post(':id/media')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Attach media to booking' })
  async attachMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { url: string; mimeType?: string; sizeBytes?: number },
    @Req() req: { user: { id: string; role: string } },
  ) {
    const media = await this.bookingsService.attachMedia(id, body, req.user);
    return { data: media };
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
  @ApiOperation({ summary: 'Create shortlist of technician invitations (≤5)' })
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
    return { data: invitations };
  }

  @Patch(':id/schedule')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reschedule booking preferred date/time window' })
  async reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ScheduleBookingDto,
    @Req() req: { user: { id: string } },
  ) {
    const booking = await this.bookingsService.reschedule(id, body, req.user);
    return { data: booking };
  }

  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('booking:create')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  async cancelBooking(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReasonDto, @Req() req: { user: { id: string } }) {
    return { data: await this.bookingsService.cancelBooking(id, body.reason, req.user) };
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
    return { data: newBooking };
  }
}
