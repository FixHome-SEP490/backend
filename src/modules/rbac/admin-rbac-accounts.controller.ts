import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { AdminRbacService } from './admin-rbac.service';
import { UpdateRolePermissionDto } from './dto/update-role-permission.dto';

/** BUG DETECTOR 261: the admin sets permissions for one service manager account, over the role. */
@ApiTags('Admin / Service manager permissions')
@Controller('admin/rbac/service-manager/accounts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminRbacAccountsController {
  constructor(private readonly adminRbacService: AdminRbacService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: list service manager accounts and whether each has its own permissions' })
  list() {
    return this.adminRbacService.listServiceManagerAccounts();
  }

  @Get(':userId/permissions')
  @ApiOperation({ summary: 'Admin: permissions of one service manager account (role default and own setting)' })
  get(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.adminRbacService.getAccountPermissions(userId);
  }

  @Put(':userId/permissions/:code')
  @ApiOperation({ summary: 'Admin: grant or revoke one permission for this account only' })
  @ApiParam({ name: 'code', example: 'order:cancel' })
  update(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('code') code: string,
    @Body() dto: UpdateRolePermissionDto,
    @CurrentUser() user: User,
  ) {
    return this.adminRbacService.setAccountPermission(userId, code, dto.granted, { id: user.id, role: user.role });
  }

  @Delete(':userId/permissions')
  @ApiOperation({ summary: 'Admin: drop the account setting, the account follows the role again' })
  reset(@Param('userId', ParseUUIDPipe) userId: string, @CurrentUser() user: User) {
    return this.adminRbacService.resetAccountPermissions(userId, { id: user.id, role: user.role });
  }
}
