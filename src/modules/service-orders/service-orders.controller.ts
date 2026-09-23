// src/modules/service-orders/service-orders.controller.ts
import {
  Controller,
  ParseUUIDPipe,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { EvidenceFile } from '../media/order-evidence-storage.service';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import { CheckInDto, UpdateLocationDto, EvidenceDto, CompletionRequestDto, CompletionConfirmationDto, ReasonDto, TrackOrderDto } from './order-command.dto';
import { ServiceOrdersService } from './service-orders.service';
import {
  ServiceOrderStatus,
} from '../../shared/enums';
import {
  CashSettlementConfirmationDto,
  CashSettlementDeclarationDto,
  CashSettlementResponseDto,
  CommissionDueResponseDto,
  InitiatePaymentDto,
  InvoiceResponseDto,
  PaymentResponseDto,
} from '../finance/dto';

@ApiTags('Service Orders')
@Controller()
export class ServiceOrdersController {
  constructor(private readonly serviceOrdersService: ServiceOrdersService) {}

  // ── 1. Order Queries ──

  @Post('service-orders/public/track')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Public guest lookup by order code + registered phone (no auth)' })
  async trackPublic(@Body() dto: TrackOrderDto) {
    const data = await this.serviceOrdersService.trackPublic(dto.orderCode, dto.phone);
    return { data };
  }

  @Get('service-orders')
  @Roles(Role.ADMIN, Role.SERVICE_MANAGER)
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List all service orders (SM / Admin board)' })
  async findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: ServiceOrderStatus,
    @Query('search') search?: string,
  ) {
    const result = await this.serviceOrdersService.findAll({
      page: page ? parseInt(page, 10) : 1,
      limit: pageSize ? parseInt(pageSize, 10) : 20,
      status,
      search,
    });
    return { data: result.data, meta: { total: result.total } };
  }

  @Get('service-orders/my')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List my service orders (Customer / Technician)' })
  async findMy(
    @Req() req: { user: { id: string; role: string } },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: ServiceOrderStatus,
  ) {
    const result = await this.serviceOrdersService.findMyOrders(
      req.user.id,
      req.user.role,
      {
        page: page ? parseInt(page, 10) : 1,
        limit: pageSize ? parseInt(pageSize, 10) : 20,
        status,
      },
    );
    return { data: result.data, meta: { total: result.total } };
  }

  @Get('service-orders/:id')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get service order by ID' })
  async findById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const order = await this.serviceOrdersService.findById(id, req.user);
    return { data: order };
  }

  // ── 2. Order Lifecycle Transitions ──

  @Post('service-orders/:id/en-route')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:update_status')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Technician transitions order to EN_ROUTE' })
  async enRoute(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const order = await this.serviceOrdersService.enRoute(id, req.user);
    return { data: order };
  }

  @Post('service-orders/:id/check-in')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('arrival_checkin:create')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Technician: GPS arrival check-in', description: 'Only the assigned technician while EN_ROUTE. Inspect result: valid, low_accuracy or out_of_geofence. Only valid permits BEFORE evidence. A successful HTTP response alone is not proof of valid arrival.' })
  async checkIn(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: CheckInDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const checkIn = await this.serviceOrdersService.checkIn(id, body, req.user);
    return { data: checkIn };
  }

  @Patch('service-orders/:id/location')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:update_status')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Technician live GPS ping while EN_ROUTE (map tracking)' })
  async updateLocation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLocationDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const location = await this.serviceOrdersService.updateLocation(id, body, req.user);
    return { data: location };
  }

  @Post('service-orders/:id/evidence')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 3 } }))
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('evidence:upload')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Technician: upload BEFORE / AFTER / ADDITIONAL evidence', description: 'Multipart/form-data with one image file (max 10 MB) and lowercase type. BEFORE requires a valid check-in while EN_ROUTE; AFTER and ADDITIONAL are only during UNDER_REPAIR before completion request. If the storage provider is unavailable, the API may return 503: an image picker alone is not successful upload.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: {
    type: 'object', required: ['type', 'file'],
    properties: {
      type: { type: 'string', enum: ['before', 'after', 'additional'], example: 'before' },
      file: { type: 'string', format: 'binary', description: 'One JPEG, PNG or WebP image up to 10 MB.' },
      note: { type: 'string', maxLength: 2000, description: 'Optional short evidence note.' },
      capturedAt: { type: 'string', format: 'date-time', description: 'Optional ISO 8601 capture timestamp.' },
    },
  } })
  async uploadEvidence(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: EvidenceDto,
    @Req() req: { user: { id: string; role: string } },
    @UploadedFile() file?: EvidenceFile,
  ) {
    const evidence = await this.serviceOrdersService.uploadEvidence(
      id,
      body,
      req.user,
      file,
    );
    return { data: evidence };
  }

  @Get('service-orders/:id/evidence')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all repair evidence photos for service order' })
  async getEvidence(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const evidence = await this.serviceOrdersService.getEvidence(id, req.user);
    return { data: evidence };
  }

  @Delete('service-orders/:id/evidence/:evidenceId')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('evidence:upload')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Technician: delete evidence photo' })
  async deleteEvidence(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    await this.serviceOrdersService.deleteEvidence(id, evidenceId, req.user);
    return { data: { success: true } };
  }

  @Post('service-orders/:id/start-repair')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:update_status')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start repair (requires valid check-in and BEFORE evidence)',
  })
  async startRepair(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const order = await this.serviceOrdersService.startRepair(id, req.user);
    return { data: order };
  }

  @Post('service-orders/:id/request-completion')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:update_status')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Technician requests completion (requires AFTER evidence)',
    description: 'Requires UNDER_REPAIR and required evidence/approvals. Generates invoice and records the completion request, but does NOT immediately change status to COMPLETED.',
  })
  async requestCompletion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CompletionRequestDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const order = await this.serviceOrdersService.requestCompletion(
      id,
      body,
      req.user,
    );
    return { data: order };
  }

  @Post('service-orders/:id/confirm-completion')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Customer confirms work; verified payment still required',
    description: 'Only the booking customer can confirm after the technician requested completion. COMPLETED requires both confirmation and a verified paid invoice/order; this endpoint does not itself charge Wallet or mark payment PAID.',
  })
  async confirmCompletion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CompletionConfirmationDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const result = await this.serviceOrdersService.confirmCompletion(
      id,
      body,
      req.user,
    );
    return { data: result };
  }

  @Post('service-orders/:id/complete')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:update_status')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Complete repair (requires AFTER evidence, generates invoice)',
  })
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CompletionRequestDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const order = await this.serviceOrdersService.complete(
      id,
      body,
      req.user,
    );
    return { data: order };
  }

  @Post('service-orders/:id/cancel')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:cancel')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel service order with strike/compensation logic' })
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const order = await this.serviceOrdersService.cancel(
      id,
      body,
      req.user,
    );
    return { data: order };
  }

  // ── 3. Order Details & History ──

  @Get('service-orders/:id/status-history')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_status_history')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get order status history (D-22 timeline)' })
  async getStatusHistory(@Param('id', ParseUUIDPipe) id: string, @Req() req: { user: { id: string; role: string } }) {
    const history = await this.serviceOrdersService.getStatusHistory(id, req.user);
    return { data: history };
  }

  @Get('service-orders/:id/invoice')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('invoice:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get invoice for service order' })
  @ApiOkResponse({ type: InvoiceResponseDto, description: 'Invoice or null' })
  @ApiNotFoundResponse({ description: 'Order or invoice not found' })
  async getInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const invoice = await this.serviceOrdersService.getInvoice(id, req.user);
    return { data: invoice };
  }

  @Post('invoices/:id/pay')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('invoice:pay_own')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initiate invoice payment with server-derived amount' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid idempotency key' })
  @ApiConflictResponse({ description: 'Idempotency or invoice payment conflict' })
  @ApiServiceUnavailableResponse({ description: 'Provider verification is unavailable' })
  async payInvoice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InitiatePaymentDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const payment = await this.serviceOrdersService.payInvoice(id, req.user, dto);
    return { data: payment };
  }

  @Post('invoices/:id/vnpay-url')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('invoice:pay_own')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a VNPay redirect URL for an unpaid invoice' })
  @ApiServiceUnavailableResponse({ description: 'VNPay is not configured or not LIVE' })
  async createInvoiceVnpayUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string }; ip: string },
  ) {
    const result = await this.serviceOrdersService.createInvoiceVnpayUrl(
      id,
      req.user,
      req.ip,
    );
    return { data: result };
  }

  @Get('service-orders/:id/warranties')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('warranty:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get warranty coverages for service order' })
  async getWarranties(@Param('id', ParseUUIDPipe) id: string, @Req() req: { user: { id: string; role: string } }) {
    const warranties = await this.serviceOrdersService.getWarranties(id, req.user);
    return { data: warranties };
  }

  // ── Spec v1.2: Cash Settlement Dual-Confirmation ──

  @Post('service-orders/:id/cash-settlement/declare')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:update_status')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Technician declares cash received for service order' })
  @ApiOkResponse({ type: CashSettlementResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid whole-VND declaration' })
  @ApiConflictResponse({ description: 'Exact invoice match failed or settlement is disputed' })
  async declareCashSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CashSettlementDeclarationDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const settlement = await this.serviceOrdersService.declareCashSettlement(id, body, req.user);
    return { data: settlement };
  }

  @Post('service-orders/:id/cash-settlement/confirm')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Customer confirms or disputes cash payment' })
  @ApiOkResponse({ type: CashSettlementResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid confirmation or missing dispute reason' })
  @ApiConflictResponse({ description: 'Cash mismatch requires Support Case review' })
  async confirmCashSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CashSettlementConfirmationDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const settlement = await this.serviceOrdersService.confirmCashSettlement(id, body, req.user);
    return { data: settlement };
  }

  @Get('service-orders/:id/cash-settlement')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get cash settlement status for order' })
  @ApiOkResponse({ type: CashSettlementResponseDto, description: 'Settlement or null' })
  async getCashSettlement(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const settlement = await this.serviceOrdersService.getCashSettlement(id, req.user);
    return { data: settlement };
  }

  // ── Spec v1.2 & v1.4: PlatformDues / Commission Dues (Technician 10% Labor Debt) ──

  @Get(['commission-dues/my', 'platform-dues/my'])
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my platform / commission dues (Technician)' })
  @ApiOkResponse({ type: CommissionDueResponseDto, isArray: true })
  async getMyCommissionDues(@Req() req: { user: { id: string; role: string } }) {
    const result = await this.serviceOrdersService.getCommissionDues(req.user);
    return { data: result.data, meta: { totalDue: result.totalDue } };
  }

  @Post(['commission-dues/:id/pay', 'platform-dues/:id/pay'])
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Initiate commission due payment with server-derived amount' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid idempotency key' })
  @ApiConflictResponse({ description: 'Idempotency or commission due payment conflict' })
  @ApiServiceUnavailableResponse({ description: 'Provider verification is unavailable' })
  async payCommissionDue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InitiatePaymentDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const payment = await this.serviceOrdersService.payCommissionDue(id, req.user, dto);
    return { data: payment };
  }

  // ── Spec v1.2: Warranty Claims ──

  @Post('service-orders/:id/warranty-claims')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit warranty claim for order' })
  async createWarrantyClaim(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { description: string },
    @Req() req: { user: { id: string } },
  ) {
    const claim = await this.serviceOrdersService.createWarrantyClaim(id, body, req.user);
    return { data: claim };
  }

  @Get('service-orders/:id/warranty-claims')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get warranty claims for order' })
  async getWarrantyClaims(@Param('id', ParseUUIDPipe) id: string, @Req() req: { user: { id: string; role: string } }) {
    const claims = await this.serviceOrdersService.getWarrantyClaims(id, req.user);
    return { data: claims };
  }

  // ── 4. Repair History (D-20 Read Model) ──

  @Get('repair-history')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('history:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get repair history (D-20 derived read model)' })
  async getRepairHistory(
    @Req() req: { user: { id: string; role: string } },
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const result = await this.serviceOrdersService.getRepairHistory(
      req.user.id,
      req.user.role,
      {
        page: page ? parseInt(page, 10) : 1,
        limit: pageSize ? parseInt(pageSize, 10) : 20,
      },
    );
    return { data: result.data, meta: { total: result.total } };
  }

  // ── 5. Operations: Cancellations & Strikes ──

  @Get('cancellations')
  @Roles(Role.ADMIN, Role.SERVICE_MANAGER)
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List cancellations for SM/Admin review' })
  async getCancellations(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const result = await this.serviceOrdersService.getCancellations({
      page: page ? parseInt(page, 10) : 1,
      limit: pageSize ? parseInt(pageSize, 10) : 20,
    });
    return { data: result.data, meta: { total: result.total } };
  }

  @Post('cancellations/:id/review')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('compensation:decide')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Review cancellation: waive strike, decide compensation' })
  async reviewCancellation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body()
    body: {
      waiveStrike?: boolean;
      waiveReason?: string;
      compensationDecision?: 'GRANTED' | 'REJECTED';
      grantPriorityBoost?: boolean;
    },
    @Req() req: { user: { id: string; role: string } },
  ) {
    const cancellation = await this.serviceOrdersService.reviewCancellation(
      id,
      body,
      req.user,
    );
    return { data: cancellation };
  }

  @Get('strikes')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('strike:read_all')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List cancellation strikes (SM / Admin)' })
  async getStrikes(
    @Query('userId') userId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const result = await this.serviceOrdersService.getStrikes({
      userId,
      page: page ? parseInt(page, 10) : 1,
      limit: pageSize ? parseInt(pageSize, 10) : 20,
    });
    return { data: result.data, meta: { total: result.total } };
  }

  @Post('strikes/:id/waive')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('strike:waive')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Waive cancellation strike (SM / Admin)' })
  async waiveStrike(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const strike = await this.serviceOrdersService.waiveStrike(
      id,
      body,
      req.user,
    );
    return { data: strike };
  }
}
