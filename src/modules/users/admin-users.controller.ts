// src/modules/users/admin-users.controller.ts
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
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UsersService } from './users.service';
import { QueryUsersDto, UpdateUserStatusDto, CreateTechnicianDto } from './dto';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { UserProfileDto } from '../auth/dto';

@ApiTags('Admin / Users')
@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: Search, filter, and paginate users' })
  @ApiResponse({
    status: 200,
    description: 'Paginated user list fetched successfully',
  })
  async findUsers(@Query() query: QueryUsersDto) {
    const { data, meta } = await this.usersService.findUsers(query);
    return {
      data: data.map((u) => UserProfileDto.fromUser(u)),
      meta,
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: Get user details by ID' })
  @ApiResponse({
    status: 200,
    description: 'User details fetched successfully',
    type: UserProfileDto,
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getUserById(@Param('id', ParseUUIDPipe) id: string) {
    const user = await this.usersService.getUserById(id);
    return UserProfileDto.fromUser(user);
  }

  @Post('technicians')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Admin: Onboard a Technician account (self-register only allows Customer)',
  })
  @ApiResponse({ status: 201, description: 'Technician account created; response includes a one-time temp password' })
  @ApiResponse({ status: 409, description: 'Email or phone number already registered' })
  async createTechnician(
    @Body() dto: CreateTechnicianDto,
    @CurrentUser() adminUser: any,
  ) {
    const { user, tempPassword } = await this.usersService.createTechnician(dto, {
      id: adminUser.id,
      role: adminUser.role,
    });
    return { data: { user: UserProfileDto.fromUser(user), tempPassword } };
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Admin: Update user account status (ACTIVE, LOCKED, SUSPENDED)',
  })
  @ApiResponse({
    status: 200,
    description: 'User status updated successfully',
    type: UserProfileDto,
  })
  @ApiResponse({ status: 404, description: 'User not found' })
  async updateUserStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
    @CurrentUser() adminUser: any,
  ) {
    const user = await this.usersService.updateUserStatus(id, dto, {
      id: adminUser.id,
      role: adminUser.role,
    });
    return UserProfileDto.fromUser(user);
  }
}
