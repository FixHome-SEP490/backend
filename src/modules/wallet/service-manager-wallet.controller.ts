import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import {
  QueryWalletsDto,
  QueryWalletTransactionsDto,
  QueryWithdrawalsDto,
} from './dto';
import { WalletService } from './wallet.service';
import { payoutMessage, toWithdrawalResponse } from './withdrawal.mapper';
import { WithdrawalPayoutService } from './withdrawal-payout.service';

/**
 * What Service Managers and Admins see of wallets and withdrawals.
 *
 * Tracking only (PO decision 30/09/2026): withdrawals are paid out the moment
 * the technician asks, so there is nothing to approve or reject here. The one
 * action left is asking payOS again about a payout still in flight.
 */
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
    summary: 'SM/Admin: Theo dõi các lệnh rút tiền của Kỹ thuật viên',
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

  @Post('withdrawals/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'SM/Admin: Hỏi lại payOS kết quả của một lệnh rút đang chuyển',
  })
  async reconcileWithdrawal(@Param('id', ParseUUIDPipe) id: string) {
    const result = await this.payoutService.reconcile(id);
    return {
      ...toWithdrawalResponse(result),
      message: payoutMessage(result.status, 'manager'),
    };
  }
}
