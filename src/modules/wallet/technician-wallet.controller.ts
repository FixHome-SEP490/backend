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
  Put,
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
  BankAccountResponseDto,
  BankOptionDto,
  CreateWithdrawalDto,
  SaveBankAccountDto,
  QueryWalletTransactionsDto,
  QueryWithdrawalsDto,
  TopUpRequestDto,
  TopUpResponseDto,
  WalletSummaryResponseDto,
  WalletTransactionResponseDto,
  WithdrawalResponseDto,
} from './dto';
import { BankAccountService } from './bank-account.service';
import { WalletService } from './wallet.service';
import { payoutMessage, toWithdrawalResponse } from './withdrawal.mapper';
import { WithdrawalPayoutService } from './withdrawal-payout.service';

@ApiTags('Technician / Wallet')
@Controller('technician/wallet')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TECHNICIAN)
@ApiBearerAuth()
export class TechnicianWalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly bankAccountService: BankAccountService,
    private readonly payoutService: WithdrawalPayoutService,
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

    // Scoped to the technician: another technician's key can neither swallow
    // this top-up nor return its transaction.
    const result = await this.walletService.topUp(
      user.id,
      dto.amount,
      `TOPUP:${user.id}:${idempotencyKey}`,
    );
    return {
      success: true,
      paymentId: result.transaction.id,
      paymentUrl: null,
      balanceAfter: result.transaction.balanceAfter,
      message: 'Nạp tiền vào ví thành công',
    };
  }

  // ------------------------------------------------------------ bank account

  @Get('banks')
  @ApiOperation({
    summary: 'Kỹ thuật viên: Danh sách ngân hàng nhận được tiền rút',
  })
  @ApiOkResponse({ type: BankOptionDto, isArray: true })
  listBanks(): readonly BankOptionDto[] {
    return this.bankAccountService.listBanks();
  }

  @Get('bank-account')
  @ApiOperation({
    summary: 'Kỹ thuật viên: Xem tài khoản ngân hàng nhận tiền rút',
    description: 'Trả về null nếu chưa khai báo.',
  })
  @ApiOkResponse({ type: BankAccountResponseDto })
  getBankAccount(
    @CurrentUser() user: User,
  ): Promise<BankAccountResponseDto | null> {
    return this.bankAccountService.getMine(user.id);
  }

  @Put('bank-account')
  @ApiOperation({
    summary: 'Kỹ thuật viên: Khai báo hoặc cập nhật tài khoản ngân hàng nhận tiền rút',
    description:
      'Chỉ lưu được khi đã duyệt KYC và tên chủ tài khoản trùng tên đã xác minh (so không dấu, không phân biệt hoa thường).',
  })
  @ApiOkResponse({ type: BankAccountResponseDto })
  saveBankAccount(
    @CurrentUser() user: User,
    @Body() dto: SaveBankAccountDto,
  ): Promise<BankAccountResponseDto> {
    return this.bankAccountService.save(user.id, dto);
  }

  // -------------------------------------------------------------- withdrawal

  @Post('withdrawals')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Kỹ thuật viên: Rút tiền, chuyển ngay qua payOS',
    description:
      'Không qua bước duyệt. Trừ ví rồi chuyển về tài khoản ngân hàng đã lưu ngay trong lần gọi. Kết quả: SUCCESS, PROCESSING (ngân hàng đang xử lý) hoặc FAILED (đã hoàn tiền về ví).',
  })
  @ApiOkResponse({ type: WithdrawalResponseDto })
  async requestWithdrawal(
    @CurrentUser() user: User,
    @Body() dto: CreateWithdrawalDto,
  ): Promise<WithdrawalResponseDto & { message: string }> {
    const withdrawal = await this.payoutService.withdraw(user.id, dto.amount);
    return {
      ...toWithdrawalResponse(withdrawal),
      message: payoutMessage(withdrawal.status, 'technician'),
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
      data: result.data.map((r) => toWithdrawalResponse(r)),
      meta: {
        page: query.page || 1,
        limit: query.limit || 20,
        total: result.total,
        totalPages: Math.ceil(result.total / (query.limit || 20)),
      },
    };
  }
}
