import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/decorators';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { Role } from '../../shared/enums';
import { CustomerBankAccountService } from './customer-bank-account.service';
import {
  CustomerWithdrawalPayoutService,
  toCustomerWithdrawalResponse,
} from './customer-withdrawal-payout.service';
import {
  BankAccountResponseDto,
  BankOptionDto,
  CreateWithdrawalDto,
  CustomerWithdrawalInfoDto,
  CustomerWithdrawalResponseDto,
  QueryWithdrawalsDto,
  SaveBankAccountDto,
} from './dto';
import { payoutMessage } from './withdrawal.mapper';

/**
 * Customer: withdraw the customer wallet to their own bank account
 * (PO 14/10/2026). Needs an approved identity verification
 * (`/customer/verification`) and a saved bank account in the verified name.
 */
@ApiTags('Customer wallet')
@Controller('customer/wallet')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.CUSTOMER)
@ApiBearerAuth()
export class CustomerWalletWithdrawalController {
  constructor(
    private readonly bankAccounts: CustomerBankAccountService,
    private readonly payouts: CustomerWithdrawalPayoutService,
  ) {}

  @Get('withdrawal-info')
  @RequirePermission('profile:read_own')
  @ApiOperation({
    summary: 'Khách hàng: điều kiện rút tiền (trạng thái KYC, tài khoản ngân hàng, mức tối thiểu, lệnh đang chuyển)',
  })
  @ApiOkResponse({ type: CustomerWithdrawalInfoDto })
  info(@CurrentUser('id') userId: string): Promise<CustomerWithdrawalInfoDto> {
    return this.payouts.info(userId);
  }

  @Get('banks')
  @RequirePermission('profile:read_own')
  @ApiOperation({ summary: 'Khách hàng: danh sách ngân hàng nhận được tiền rút' })
  @ApiOkResponse({ type: BankOptionDto, isArray: true })
  banks(): readonly BankOptionDto[] {
    return this.bankAccounts.listBanks();
  }

  @Get('bank-account')
  @RequirePermission('profile:read_own')
  @ApiOperation({ summary: 'Khách hàng: tài khoản ngân hàng nhận tiền rút (null nếu chưa khai báo)' })
  @ApiOkResponse({ type: BankAccountResponseDto })
  getBankAccount(@CurrentUser('id') userId: string): Promise<BankAccountResponseDto | null> {
    return this.bankAccounts.getMine(userId);
  }

  @Put('bank-account')
  @RequirePermission('profile:update_own')
  @ApiOperation({
    summary: 'Khách hàng: khai báo hoặc đổi tài khoản ngân hàng nhận tiền rút',
    description: 'Chỉ lưu được khi đã duyệt xác minh danh tính và tên chủ tài khoản trùng tên đã xác minh (so không dấu).',
  })
  @ApiOkResponse({ type: BankAccountResponseDto })
  saveBankAccount(
    @CurrentUser('id') userId: string,
    @Body() dto: SaveBankAccountDto,
  ): Promise<BankAccountResponseDto> {
    return this.bankAccounts.save(userId, dto);
  }

  @Post('withdrawals')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('profile:update_own')
  @ApiOperation({
    summary: 'Khách hàng: rút tiền về tài khoản ngân hàng đã lưu, chuyển ngay qua payOS',
    description:
      'Rút được toàn bộ số dư, tối thiểu 10.000 ₫ mỗi lần, không phí. Kết quả: SUCCESS, PROCESSING (ngân hàng đang xử lý) hoặc FAILED (đã hoàn tiền về ví).',
  })
  @ApiOkResponse({ type: CustomerWithdrawalResponseDto })
  async withdraw(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateWithdrawalDto,
  ): Promise<CustomerWithdrawalResponseDto & { message: string }> {
    const withdrawal = await this.payouts.withdraw(userId, dto.amount);
    return {
      ...toCustomerWithdrawalResponse(withdrawal),
      message: payoutMessage(withdrawal.status, 'customer'),
    };
  }

  @Get('withdrawals')
  @RequirePermission('profile:read_own')
  @ApiOperation({ summary: 'Khách hàng: lịch sử rút tiền (mới nhất trước, phân trang page/limit, lọc status)' })
  listWithdrawals(@CurrentUser('id') userId: string, @Query() query: QueryWithdrawalsDto) {
    return this.payouts.listMine(userId, query);
  }
}
