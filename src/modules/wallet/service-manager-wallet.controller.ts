import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
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
import { Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import {
  QueryWalletsDto,
  QueryWalletTransactionsDto,
  QueryWithdrawalsDto,
  RejectWithdrawalDto,
} from './dto';
import { WalletService } from './wallet.service';

@ApiTags('Service Manager / Wallets')
@Controller('service-manager')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SERVICE_MANAGER, Role.ADMIN)
@ApiBearerAuth()
export class ServiceManagerWalletController {
  constructor(private readonly walletService: WalletService) {}

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
        processedByUserId: r.processedByUserId,
        rejectReason: r.rejectReason,
        technician: r.technician
          ? {
              id: r.technician.id,
              fullName: r.technician.fullName,
              phoneNumber: r.technician.phoneNumber,
              email: r.technician.email,
              avatarUrl: r.technician.avatarUrl,
            }
          : null,
      })),
      meta: {
        page: query.page || 1,
        limit: query.limit || 20,
        total: result.total,
        totalPages: Math.ceil(result.total / (query.limit || 20)),
      },
    };
  }

  @Patch('withdrawals/:id/approve')
  @ApiOperation({
    summary: 'SM/Admin: Phê duyệt yêu cầu rút tiền của Kỹ thuật viên',
  })
  async approveWithdrawal(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    const result = await this.walletService.approveWithdrawal(id, {
      id: user.id,
      role: user.role,
    });
    return {
      success: true,
      id: result.id,
      status: result.status,
      processedAt: result.processedAt,
      message: 'Phê duyệt yêu cầu rút tiền thành công',
    };
  }

  @Patch('withdrawals/:id/reject')
  @ApiOperation({
    summary: 'SM/Admin: Từ chối yêu cầu rút tiền của Kỹ thuật viên',
  })
  async rejectWithdrawal(
    @Param('id') id: string,
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
