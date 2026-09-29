import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Role, WithdrawalStatus } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import {
  QueryWalletsDto,
  QueryWalletTransactionsDto,
  QueryWithdrawalsDto,
  RejectWithdrawalDto,
} from './dto';
import { WalletService } from './wallet.service';
import { toWithdrawalResponse } from './withdrawal.mapper';
import { WithdrawalPayoutService } from './withdrawal-payout.service';

@ApiTags('Service Manager / Wallets')
@Controller('service-manager')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SERVICE_MANAGER, Role.ADMIN)
@ApiBearerAuth()
export class ServiceManagerWalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly payoutService: WithdrawalPayoutService,
  ) {}

  @Get('wallets')
  @ApiOperation({
    summary: 'SM/Admin: Danh sách ví Kỹ thuật viên kèm trạng thái đủ điều kiện nhận việc',
  })
  async listWallets(@Query() query: QueryWalletsDto) {
    const result = await this.walletService.listWallets(query);
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

  @Get('wallets/:technicianId')
  @ApiOperation({
    summary: 'SM/Admin: Xem chi tiết ví một Kỹ thuật viên',
  })
  async getWalletDetail(@Param('technicianId') technicianId: string) {
    return this.walletService.getWalletSummary(technicianId);
  }

  @Get('wallets/:technicianId/transactions')
  @ApiOperation({
    summary: 'SM/Admin: Xem lịch sử giao dịch ví của một Kỹ thuật viên',
  })
  async getWalletTransactions(
    @Param('technicianId') technicianId: string,
    @Query() query: QueryWalletTransactionsDto,
  ) {
    const summary = await this.walletService.getWalletSummary(technicianId);
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

  @Get('withdrawals')
  @ApiOperation({
    summary: 'SM/Admin: Danh sách các yêu cầu rút tiền',
  })
  async listWithdrawals(@Query() query: QueryWithdrawalsDto) {
    const result = await this.walletService.listWithdrawals(query);
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

  @Get('withdrawals/payout-overview')
  @ApiOperation({
    summary: 'SM/Admin: Tổng tiền đã chi, đang chuyển và số dư ví nguồn chi hộ',
  })
  overview() {
    return this.payoutService.overview();
  }

  @Patch('withdrawals/:id/approve')
  @ApiOperation({
    summary: 'SM/Admin: Duyệt yêu cầu rút tiền và chi tự động qua payOS',
    description:
      'Kiểm tra ví nguồn đủ tiền, trừ ví kỹ thuật viên rồi gửi lệnh chi. Kết quả trả về là SUCCESS, PROCESSING (payOS đang xử lý) hoặc FAILED (đã hoàn tiền về ví).',
  })
  async approveWithdrawal(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: User,
  ) {
    const result = await this.payoutService.approve(id, {
      id: user.id,
      role: user.role,
    });
    return {
      ...toWithdrawalResponse(result),
      message: approvalMessage(result.status),
    };
  }

  @Post('withdrawals/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'SM/Admin: Hỏi lại payOS kết quả của một lệnh rút đang chuyển',
  })
  async reconcileWithdrawal(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.payoutService.reconcile(id);
    return {
      ...toWithdrawalResponse(result),
      message: approvalMessage(result.status),
    };
  }

  @Patch('withdrawals/:id/reject')
  @ApiOperation({
    summary: 'SM/Admin: Từ chối yêu cầu rút tiền của Kỹ thuật viên',
  })
  async rejectWithdrawal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectWithdrawalDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.walletService.rejectWithdrawal(id, dto.reason, {
      id: user.id,
      role: user.role,
    });
    return {
      success: true,
      id: result.id,
      status: result.status,
      rejectReason: result.rejectReason,
      processedAt: result.processedAt,
      message: 'Từ chối yêu cầu rút tiền thành công',
    };
  }
}

function approvalMessage(status: WithdrawalStatus): string {
  switch (status) {
    case WithdrawalStatus.SUCCESS:
      return 'Đã chi tiền về tài khoản ngân hàng của kỹ thuật viên';
    case WithdrawalStatus.PROCESSING:
      return 'Đã gửi lệnh chi, payOS đang xử lý. Hệ thống sẽ tự cập nhật kết quả.';
    case WithdrawalStatus.FAILED:
      return 'Chi tiền không thành công, số tiền đã được hoàn lại vào ví kỹ thuật viên';
    default:
      return 'Đã cập nhật yêu cầu rút tiền';
  }
}
