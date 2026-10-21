import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReasonDto } from '../service-orders/order-command.dto';
import { ScheduleBookingDto, ShortlistDto } from '../bookings/booking.dto';
import { toBookingInvitationResponse } from '../bookings/booking-privacy.dto';
import { CreateVisitGroupDto, VisitGroupConsultationDto } from './visit-group.dto';
import { VisitGroupsService } from './visit-groups.service';

type AuthedRequest = { user: { id: string; role: string } };

@ApiTags('Visit groups')
@ApiBearerAuth()
@Controller('visit-groups')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class VisitGroupsController {
  constructor(private readonly visitGroups: VisitGroupsService) {}

  @Get('contact')
  @RequirePermission('booking:create')
  @ApiOperation({ summary: 'Customer: is booking several devices open, the device limit and the support hotline (null until configured)' })
  async contact() {
    return { data: await this.visitGroups.contact() };
  }

  @Post()
  @RequirePermission('booking:create')
  @ApiOperation({ summary: 'Customer: book 1 to 3 physical devices in one visit', description: 'Creates one child Booking (quantity 1) per device in one transaction, sharing address and arrival session. A fourth device is refused with VISIT_GROUP_DEVICE_LIMIT (422); the hotline comes from GET /visit-groups/contact. 403 FEATURE_DISABLED while visit_group.enabled is not true.' })
  async create(@Body() dto: CreateVisitGroupDto, @Req() req: AuthedRequest) {
    return { data: await this.visitGroups.create(dto, req.user) };
  }

  @Post('consultation')
  @RequirePermission('booking:create')
  @ApiOperation({ summary: 'Customer: ask for help with more devices than one visit takes', description: 'Opens a support case for the service managers; returns it with the hotline.' })
  async consultation(@Body() dto: VisitGroupConsultationDto, @Req() req: AuthedRequest) {
    return { data: await this.visitGroups.requestConsultation(dto, req.user) };
  }

  @Get('my')
  @RequirePermission('booking:read_own')
  @ApiOperation({ summary: 'Customer: my visit groups with each device\'s service and status' })
  async mine(@Req() req: AuthedRequest) {
    return { data: await this.visitGroups.mine(req.user) };
  }

  @Get(':id')
  @RequirePermission('booking:read_own')
  @ApiOperation({ summary: 'Customer: one visit group with its devices and their bookings' })
  async detail(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return { data: await this.visitGroups.detail(id, req.user) };
  }

  @Get(':id/technician-candidates')
  @RequirePermission('invitation:shortlist')
  @ApiOperation({ summary: 'Customer: technicians who offer every device of the visit and are free for its session' })
  async candidates(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return { data: await this.visitGroups.candidates(id, req.user) };
  }

  @Post(':id/shortlist')
  @RequirePermission('invitation:shortlist')
  @ApiOperation({ summary: 'Customer: invite one or two technicians for the whole visit', description: 'Same rules as POST /bookings/:id/shortlist, on the visit\'s lead booking (leadBookingId in GET /visit-groups/:id). Accept creates one ServiceOrder per device in one transaction.' })
  async shortlist(@Param('id', ParseUUIDPipe) id: string, @Body() body: ShortlistDto, @Req() req: AuthedRequest) {
    const invitations = await this.visitGroups.shortlist(id, body.technicianIds, req.user);
    return { data: invitations.map(toBookingInvitationResponse) };
  }

  @Post(':id/matching/extend')
  @RequirePermission('booking:create')
  @ApiOperation({ summary: 'Customer: the one extension of the live invitation round, for the whole visit' })
  async extendMatching(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return { data: await this.visitGroups.extendMatching(id, req.user) };
  }

  @Post(':id/reschedule')
  @RequirePermission('booking:create')
  @ApiOperation({ summary: 'Customer: move the whole visit to another session (once per visit)', description: 'Same rules as PATCH /bookings/:id/schedule for every device together; the technician holding the visit must be free in the new session.' })
  async reschedule(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ScheduleBookingDto, @Req() req: AuthedRequest) {
    return { data: await this.visitGroups.reschedule(id, dto, req.user) };
  }

  @Post(':id/withdraw')
  @RequirePermission('order:cancel')
  @ApiOperation({ summary: 'Technician: drop the whole visit before arriving', description: 'Every device\'s order loses its technician and the visit is matched again; points are taken once. After arrival, ask a Service Manager.' })
  async withdraw(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: AuthedRequest) {
    return { data: await this.visitGroups.withdraw(id, dto.reason, req.user) };
  }

  @Post(':id/cancel')
  @RequirePermission('booking:create')
  @ApiOperation({ summary: 'Customer: cancel the whole visit', description: 'Before a technician holds it the bookings are cancelled; after, every order is cancelled by the order rules (not during repair), with the points of one cancellation.' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: AuthedRequest) {
    return { data: await this.visitGroups.cancel(id, dto.reason, req.user) };
  }
}
