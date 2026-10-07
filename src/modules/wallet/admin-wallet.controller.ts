import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { AdminConfigService } from '../system-config/admin-config.service';
import { BusinessConfigService } from '../system-config/business-config.service';
import { User } from '../users/entities/user.entity';
import {
  AdminWalletAdjustmentDto,
  QueryWalletsDto,
  UpdateWalletConfigDto,
  WalletConfigResponseDto,
} from './dto';
import { WalletService } from './wallet.service';

@ApiTags('Admin / Wallets')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminWalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly businessConfigService: BusinessConfigService,
    private readonly adminConfigService: AdminConfigService,
  ) {}

  @Get('wallets')
  @ApiOperation({ summary: 'Admin: Danh sách toàn bộ ví kỹ thuật viên' })
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
  @ApiOperation({ summary: 'Admin: Xem chi tiết ví một kỹ thuật viên' })
  async getWalletDetail(@Param('technicianId', ParseUUIDPipe) technicianId: string) {
    return this.walletService.getTechnicianWalletSummary(technicianId);
  }

  @Post('wallets/:technicianId/adjustments')
  @ApiOperation({
    summary: 'Admin: Điều chỉnh số dư ví (CREDIT / DEBIT) với lý do bắt buộc và audit trail',
  })
  async adjustWallet(
    @Param('technicianId', ParseUUIDPipe) technicianId: string,
    @Body() dto: AdminWalletAdjustmentDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.walletService.adminAdjustBalance(
      technicianId,
      dto,
      { id: user.id, role: user.role },
    );
    return {
      success: true,
      technicianId,
      balanceAfter: result.wallet.balance,
      transactionId: result.transaction.id,
      message: 'Điều chỉnh số dư ví thành công',
    };
  }

  @Get('wallet-config')
  @ApiOperation({ summary: 'Admin: Xem cấu hình ví và tỷ lệ phí nền tảng' })
  async getWalletConfig(): Promise<WalletConfigResponseDto> {
    const minimumWalletBalance = await this.walletService.getMinimumBalance();
    const platformFeeRateBps = await this.businessConfigService.getInt(
      'commission.rate_bps',
      1000,
    );
    return {
      minimumWalletBalance,
      platformFeeRateBps,
      platformFeePercent: `${(platformFeeRateBps / 100).toFixed(1)}%`,
    };
  }

  @Patch('wallet-config')
  @ApiOperation({ summary: 'Admin: Cập nhật cấu hình ví và tỷ lệ phí' })
  async updateWalletConfig(
    @Body() dto: UpdateWalletConfigDto,
    @CurrentUser() user: User,
  ): Promise<WalletConfigResponseDto> {
    if (dto.minimumWalletBalance !== undefined) {
      await this.adminConfigService.update(
        'wallet.minimum_balance',
        String(dto.minimumWalletBalance),
        user.id,
        user.role,
      );
    }
    if (dto.platformFeeRateBps !== undefined) {
      await this.adminConfigService.update(
        'commission.rate_bps',
        String(dto.platformFeeRateBps),
        user.id,
        user.role,
      );
    }

    return this.getWalletConfig();
  }
}
