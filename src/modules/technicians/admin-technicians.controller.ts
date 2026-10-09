import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Role } from '../../shared/enums';
import { AdminTechniciansService } from './admin-technicians.service';

@ApiTags('Admin technicians')
@Controller('admin/technicians')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.ADMIN)
@RequirePermission('user:read_all')
@ApiBearerAuth()
export class AdminTechniciansController {
  constructor(private readonly service: AdminTechniciansService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: find technicians by name, email, phone, citizen id (CCCD) or id; never by address' })
  search(
    @Query('search') search?: string,
    @Query('verificationStatus') verificationStatus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.search({ search, verificationStatus, page: Number(page), pageSize: Number(pageSize) });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: everything about one technician (account, profile, skills, areas, schedule, wallet, orders, KYC, reputation)' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }
}
