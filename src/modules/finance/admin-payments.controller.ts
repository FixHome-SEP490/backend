import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission, Roles } from '../../common/decorators';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { AdminPaymentsService } from './admin-payments.service';

/** Admin: the list of payment attempts (PO 09/10/2026). Read only. */
@ApiTags('Admin / Payments')
@Controller('admin/payments')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.ADMIN)
@RequirePermission('invoice:read_related')
@ApiBearerAuth()
export class AdminPaymentsController {
  constructor(private readonly service: AdminPaymentsService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: payments, newest first; filter by status, purpose, provider (none = no provider), Vietnam days; search order code, payer, provider reference or id' })
  list(
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('purpose') purpose?: string,
    @Query('provider') provider?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list({ search, status, purpose, provider, from, to, page: Number(page), pageSize: Number(pageSize) });
  }
}
