import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { AdminCustomerWalletsService } from './admin-customer-wallets.service';

export class AdminCustomerWalletAdjustmentDto {
  @ApiProperty({ enum: ['CREDIT', 'DEBIT'], description: 'CREDIT cộng tiền, DEBIT trừ tiền' })
  @IsIn(['CREDIT', 'DEBIT'])
  type: 'CREDIT' | 'DEBIT';

  @ApiProperty({ example: 50000, description: 'VND, nguyên dương' })
  @IsInt()
  @Min(1)
  @Max(100000000)
  amount: number;

  @ApiProperty({ example: 'Bù khoản hoàn ghi thiếu cho đơn FH-123' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}

/** Admin: customer wallets (PO 09/10/2026), mirroring the technician wallet tools. */
@ApiTags('Admin / Customer wallets')
@Controller('admin/customer-wallets')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminCustomerWalletsController {
  constructor(private readonly service: AdminCustomerWalletsService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: customers with their wallet balance, largest first' })
  list(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('withBalance') withBalance?: string,
  ) {
    return this.service.list({ search, page: Number(page), pageSize: Number(pageSize), withBalance: withBalance === 'true' });
  }

  @Get(':userId')
  @ApiOperation({ summary: 'Admin: one customer wallet with its transactions' })
  detail(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.detail(userId, Number(page) || 1, Number(pageSize) || 20);
  }

  @Post(':userId/adjustments')
  @ApiOperation({ summary: 'Admin: credit or debit a customer wallet with a reason (audited, customer notified)' })
  adjust(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: AdminCustomerWalletAdjustmentDto,
    @CurrentUser() user: User,
  ) {
    return this.service.adjust(userId, dto, { id: user.id, role: user.role });
  }
}
