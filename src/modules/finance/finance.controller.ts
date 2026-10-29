import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiUnauthorizedResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import {
  PlatformDueQueryDto,
  PlatformDueResponseDto,
  VoucherCashConfirmationDto,
  VoucherCashDeclarationDto,
  VoucherCashReservationResponseDto,
  VoucherReservationDto,
} from './dto';
import { FinanceService } from './finance.service';

@ApiTags('Finance')
@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.SERVICE_MANAGER, Role.ADMIN)
@RequirePermission('invoice:read_related')
@ApiBearerAuth()
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  @Get('platform-dues')
  @ApiOperation({ summary: 'Manager/Admin: list immutable platform due snapshots' })
  @ApiOkResponse({
    description: 'Platform due snapshots returned with pagination metadata',
    type: PlatformDueResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid platform due filters or pagination' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Manager/Admin finance read permission required' })
  async listPlatformDues(@Query() query: PlatformDueQueryDto) {
    const result = await this.financeService.listPlatformDues(query);
    return {
      data: result.data,
      meta: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / query.limit),
      },
    };
  }
}

type FundedRequest = { user: { id: string; role: string }; ip?: string;
  headers?: Record<string, string | undefined> };

/** Separate funded URLs keep the existing gross checkout contracts intact. */
@ApiTags('Funded finance')
@Controller('finance/funded')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@ApiBearerAuth()
@ApiBadRequestResponse({ description: 'Malformed UUID, reservation or cash declaration' })
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@ApiForbiddenResponse({ description: 'Role, permission or resource ownership denied' })
@ApiServiceUnavailableResponse({ description: 'Funded collection requires the applied funding migration and available settlement dependencies' })
export class FundedFinanceController {
  constructor(private readonly finance: FinanceService) {}

  private async assertPaidCollectionReady(): Promise<void> {
    await this.finance.assertFundedCollectionReady();
  }

  private platform(req: FundedRequest): 'web' | 'mobile' {
    const ua = req.headers?.['user-agent']?.toLowerCase() ?? '';
    return req.headers?.['x-client-platform'] === 'mobile' || ua.includes('okhttp') || ua.includes('cfnetwork')
      ? 'mobile' : 'web';
  }

  @Get('solo/:id/cash/reservation')
  @Header('Cache-Control', 'no-store')
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Kỹ thuật viên phụ trách xem số tiền mặt sau ưu đãi của đơn sửa chữa' })
  @ApiOkResponse({ type: VoucherCashReservationResponseDto, description: 'Hai field null nếu không có reservation đang giữ; không dùng lỗi làm tín hiệu thu gross.' })
  @ApiConflictResponse({ description: 'Reservation hết hạn, mơ hồ, hóa đơn thay đổi hoặc đã có collection.' })
  async soloCashReservation(@Param('id', ParseUUIDPipe) id: string, @Req() req: FundedRequest) {
    return { data: await this.finance.getVoucherCashReservation('SOLO', id, req.user) };
  }

  @Get('visit-groups/:id/cash/reservation')
  @Header('Cache-Control', 'no-store')
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Kỹ thuật viên phụ trách xem số tiền mặt sau ưu đãi của lượt sửa' })
  @ApiOkResponse({ type: VoucherCashReservationResponseDto, description: 'Hai field null nếu không có reservation đang giữ; không dùng lỗi làm tín hiệu thu gross.' })
  @ApiConflictResponse({ description: 'Reservation hết hạn, mơ hồ, hóa đơn thay đổi hoặc đã có collection.' })
  async visitCashReservation(@Param('id', ParseUUIDPipe) id: string, @Req() req: FundedRequest) {
    return { data: await this.finance.getVoucherCashReservation('VISIT_GROUP', id, req.user) };
  }

  @Post('solo/:id/wallet')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CUSTOMER)
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: pay a solo invoice from wallet at server-funded due' })
  async soloWallet(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherReservationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    return { data: await this.finance.payInvoiceWithWallet(id, req.user, body.voucherReservationId) };
  }

  @Post('solo/:id/vnpay')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CUSTOMER)
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: sign a VNPay URL for server-funded solo due' })
  async soloVnpay(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherReservationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    return { data: await this.finance.createVnpayPaymentUrl(id, req.user, req.ip || '127.0.0.1',
      this.platform(req), req.headers?.origin, body.voucherReservationId) };
  }

  @Post('solo/:id/cash/declare')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:update_status')
  @ApiOperation({ summary: 'Technician: declare the physical cash received for a funded solo order' })
  async soloCashDeclare(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherCashDeclarationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    const { voucherReservationId, ...declaration } = body;
    return { data: await this.finance.declareCashSettlement(id, declaration, req.user, voucherReservationId) };
  }

  @Post('solo/:id/cash/confirm')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CUSTOMER)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Customer: confirm funded solo cash before technician subsidy credit' })
  async soloCashConfirm(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherCashConfirmationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    const { voucherReservationId, ...confirmation } = body;
    return { data: await this.finance.confirmVoucherCashByReservation(id, confirmation, req.user, voucherReservationId) };
  }

  @Post('solo/:id/zero-closeout')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CUSTOMER)
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: close a verified fully funded solo invoice without VNPay' })
  async soloZero(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherReservationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    return { data: await this.finance.closeVoucherZeroDue('SOLO', id, req.user, body.voucherReservationId) };
  }

  @Post('visit-groups/:id/wallet')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CUSTOMER)
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: pay a visit group from wallet at server-funded due' })
  async visitWallet(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherReservationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    return { data: await this.finance.payVisitWithWallet(id, req.user, body.voucherReservationId) };
  }

  @Post('visit-groups/:id/vnpay')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CUSTOMER)
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: sign a VNPay URL for server-funded visit due' })
  async visitVnpay(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherReservationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    return { data: await this.finance.createVisitVnpayUrl(id, req.user, req.ip || '127.0.0.1',
      this.platform(req), req.headers?.origin, body.voucherReservationId) };
  }

  @Post('visit-groups/:id/cash/declare')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:update_status')
  @ApiOperation({ summary: 'Technician: declare the physical cash received for a funded visit' })
  async visitCashDeclare(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherCashDeclarationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    const { voucherReservationId, ...declaration } = body;
    return { data: await this.finance.declareVisitCash(id, declaration, req.user, voucherReservationId) };
  }

  @Post('visit-groups/:id/cash/confirm')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CUSTOMER)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Customer: confirm funded visit cash before technician subsidy credit' })
  async visitCashConfirm(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherCashConfirmationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    const { voucherReservationId, ...confirmation } = body;
    return { data: await this.finance.confirmVoucherVisitCashByReservation(id, confirmation, req.user, voucherReservationId) };
  }

  @Post('visit-groups/:id/zero-closeout')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.CUSTOMER)
  @RequirePermission('invoice:pay_own')
  @ApiOperation({ summary: 'Customer: close a verified fully funded visit without VNPay' })
  async visitZero(@Param('id', ParseUUIDPipe) id: string, @Body() body: VoucherReservationDto, @Req() req: FundedRequest) {
    await this.assertPaidCollectionReady();
    return { data: await this.finance.closeVoucherZeroDue('VISIT_GROUP', id, req.user, body.voucherReservationId) };
  }
}
