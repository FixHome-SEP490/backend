import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReasonDto } from '../service-orders/order-command.dto';
import { ScheduleBookingDto, ShortlistDto } from '../bookings/booking.dto';
import { toBookingInvitationResponse } from '../bookings/booking-privacy.dto';
import { CreateVisitGroupDto, VisitGroupConsultationDto } from './visit-group.dto';
import { VisitGroupsService } from './visit-groups.service';
import { FinanceService } from '../finance/finance.service';
import { CashSettlementConfirmationDto, CashSettlementDeclarationDto } from '../finance/dto';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import { VisitGroupAssignedPageQueryDto, VisitGroupMyPageQueryDto } from './visit-group-page.dto';

type AuthedRequest = { user: { id: string; role: string } };

@ApiTags('Visit groups')
@ApiBearerAuth()
@Controller('visit-groups')
@UseGuards(JwtAuthGuard, PermissionGuard)
export class VisitGroupsController {
  constructor(
    private readonly visitGroups: VisitGroupsService,
    private readonly finance: FinanceService,
  ) {}

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

  @Get('my-page')
  @RequirePermission('booking:read_own')
  @ApiOperation({ summary: 'Customer: server-paginated visit groups with child booking/order status' })
  async myPage(@Req() req: AuthedRequest, @Query() query: VisitGroupMyPageQueryDto) {
    const result = await this.visitGroups.myPage(req.user.id, query);
    return { data: result.data, meta: { total: result.total, page: result.page, pageSize: result.pageSize } };
  }

  @Get('assigned-page')
  @Roles(Role.TECHNICIAN)
  @UseGuards(RolesGuard)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Technician: server-paginated visit groups that remain actively assigned to the technician' })
  async assignedPage(@Req() req: AuthedRequest, @Query() query: VisitGroupAssignedPageQueryDto) {
    const result = await this.visitGroups.assignedPage(req.user.id, query);
    return { data: result.data, meta: { total: result.total, page: result.page, pageSize: result.pageSize } };
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

  @Get(':id/checkout')
  @RequirePermission('invoice:read_related')
  @ApiOperation({ summary: 'Customer or technician: what the visit owes', description: 'Each device with its state (succeeded, failed, quote_declined, cancelled, open) and amount; only repaired devices are charged. ready is true once every device has its result (PO 21/10/2026: one payment per visit).' })
  async checkout(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return { data: await this.finance.visitCheckout(id, req.user) };
  }

  @Post(':id/checkout/wallet')
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: pay the whole visit with one wallet debit' })
  async payWithWallet(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthedRequest) {
    return { data: await this.finance.payVisitWithWallet(id, req.user) };
  }

  @Post(':id/checkout/vnpay')
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: one VNPay transaction for the whole visit', description: 'The IPN splits it over the repaired devices\' invoices frozen at this call.' })
  async payWithVnpay(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthedRequest & { ip: string; headers?: Record<string, string | undefined> },
  ) {
    const ua = req.headers?.['user-agent']?.toLowerCase() ?? '';
    const isMobile = req.headers?.['x-client-platform'] === 'mobile' || ua.includes('okhttp') || ua.includes('cfnetwork');
    return { data: await this.finance.createVisitVnpayUrl(id, req.user, req.ip, isMobile ? 'mobile' : 'web', req.headers?.origin) };
  }

  @Post(':id/checkout/cash/declare')
  @RequirePermission('order:update_status')
  @ApiOperation({ summary: 'Technician: report the cash of the whole visit, once', description: 'declaredAmount must equal the visit total; the customer then confirms.' })
  async declareCash(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CashSettlementDeclarationDto, @Req() req: AuthedRequest) {
    return { data: await this.finance.declareVisitCash(id, dto, req.user) };
  }

  @Post(':id/checkout/cash/confirm')
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Customer: confirm the visit cash, once', description: 'Agreeing pays every repaired device\'s invoice; disagreeing opens a cash mismatch case.' })
  async confirmCash(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CashSettlementConfirmationDto, @Req() req: AuthedRequest) {
    return { data: await this.finance.confirmVisitCash(id, dto, req.user) };
  }

  @Post(':id/cancel')
  @RequirePermission('booking:create')
  @ApiOperation({ summary: 'Customer: cancel the whole visit', description: 'Before a technician holds it the bookings are cancelled; after, every order is cancelled by the order rules (not during repair), with the points of one cancellation.' })
  async cancel(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Req() req: AuthedRequest) {
    return { data: await this.visitGroups.cancel(id, dto.reason, req.user) };
  }
}
