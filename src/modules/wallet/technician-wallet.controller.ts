import {
  Body,
  Controller,
  forwardRef,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Optional,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { PaymentMode, Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { FinanceService } from '../finance/finance.service';
import {
  CreateWithdrawalDto,
  QueryWalletTransactionsDto,
  QueryWithdrawalsDto,
  TopUpRequestDto,
  TopUpResponseDto,
  WalletSummaryResponseDto,
  WalletTransactionResponseDto,
  WithdrawalResponseDto,
} from './dto';
import { WalletService } from './wallet.service';

@ApiTags('Technician / Wallet')
@Controller('technician/wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TECHNICIAN)
@ApiBearerAuth()
export class TechnicianWalletController {
  constructor(
    private readonly walletService: WalletService,
    @Optional()
    @Inject(forwardRef(() => FinanceService))
    private readonly financeService?: FinanceService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Kỹ thuật viên: Xem thông tin ví, số dư và điều kiện nhận việc',
  })
  @ApiOkResponse({ type: WalletSummaryResponseDto })
  @ApiUnauthorizedResponse({ description: 'Chưa đăng nhập' })
  @ApiForbiddenResponse({ description: 'Chỉ dành cho Kỹ thuật viên' })
  async getMyWallet(
    @CurrentUser() user: User,
  ): Promise<WalletSummaryResponseDto> {
    return this.walletService.getWalletSummary(user.id);
  }

  @Get('transactions')
  @ApiOperation({
    summary: 'Kỹ thuật viên: Xem lịch sử biến động số dư ví (phân trang)',
  })
  @ApiOkResponse({ type: WalletTransactionResponseDto, isArray: true })
  async getMyTransactions(
    @CurrentUser() user: User,
    @Query() query: QueryWalletTransactionsDto,
  ) {
    const summary = await this.walletService.getWalletSummary(user.id);
    const result = await this.walletService.listTransactions(summary.id, query);
    return {
      data: result.data,
      meta: {
        page: query.page || 1,
        limit: query.limit || 20,
        total: result.total,
        totalPages: Math.ceil(result.total / (query.limit || 20)),
      },
    };
  }

  @Post('top-up')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Kỹ thuật viên: Nạp tiền vào ví',
  })
  @ApiOkResponse({ type: TopUpResponseDto })
  async topUp(
    @CurrentUser() user: User,
    @Body() dto: TopUpRequestDto,
    @Req() req: { ip?: string; headers?: Record<string, string> } = {},
  ): Promise<TopUpResponseDto> {
    const idempotencyKey =
      dto.idempotencyKey?.trim() ||
      `TOPUP_${user.id.substring(0, 8)}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const paymentMode = this.financeService
      ? await this.financeService.getPaymentMode().catch(() => PaymentMode.DEMO)
      : PaymentMode.DEMO;

    if (paymentMode === PaymentMode.LIVE && this.financeService) {
      const isMobile =
        req.headers?.['x-client-platform'] === 'mobile' ||
        req.headers?.['user-agent']?.toLowerCase().includes('okhttp') ||
        req.headers?.['user-agent']?.toLowerCase().includes('cfnetwork');
      const vnpay = await this.financeService.createWalletTopUpVnpayUrl(
        user.id,
        dto.amount,
        req.ip || '127.0.0.1',
        idempotencyKey,
        isMobile ? 'mobile' : 'web',
      );
      return {
        success: true,
        paymentId: vnpay.paymentId,
        paymentUrl: vnpay.paymentUrl,
        balanceAfter: null,
        message: 'Khởi tạo cổng thanh toán VNPay thành công',
      };
    }

    const result = await this.walletService.topUp(
      user.id,
      dto.amount,
      idempotencyKey,
    );
    return {
      success: true,
      paymentId: result.transaction.id,
      paymentUrl: null,
      balanceAfter: result.transaction.balanceAfter,
      message: 'Nạp tiền vào ví thành công',
    };
  }

  @Post('withdrawals')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Kỹ thuật viên: Tạo yêu cầu rút tiền',
  })
  @ApiOkResponse({ type: WithdrawalResponseDto })
  async requestWithdrawal(
    @CurrentUser() user: User,
    @Body() dto: CreateWithdrawalDto,
  ): Promise<WithdrawalResponseDto> {
    const req = await this.walletService.requestWithdrawal(user.id, dto);
    return {
      id: req.id,
      walletId: req.walletId,
      technicianId: req.technicianId,
      amount: Number(req.amount),
      bankName: req.bankName,
      bankAccountNumber: req.bankAccountNumber,
      bankAccountName: req.bankAccountName,
      status: req.status,
      requestedAt: req.requestedAt,
    };
  }

  @Get('withdrawals')
  @ApiOperation({
    summary: 'Kỹ thuật viên: Xem lịch sử các yêu cầu rút tiền',
  })
  async getMyWithdrawals(
    @CurrentUser() user: User,
    @Query() query: QueryWithdrawalsDto,
  ) {
    const result = await this.walletService.listMyWithdrawals(user.id, query);
    return {
      data: result.data.map((r) => ({
        id: r.id,
        walletId: r.walletId,
        technicianId: r.technicianId,
        amount: Number(r.amount),
        bankName: r.bankName,
        bankAccountNumber: r.bankAccountNumber,
        bankAccountName: r.bankAccountName,
        status: r.status,
        requestedAt: r.requestedAt,
        processedAt: r.processedAt,
        rejectReason: r.rejectReason,
      })),
      meta: {
        page: query.page || 1,
        limit: query.limit || 20,
        total: result.total,
        totalPages: Math.ceil(result.total / (query.limit || 20)),
      },
    };
  }
}
