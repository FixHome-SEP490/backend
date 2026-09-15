import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import {
  PlatformDueQueryDto,
  PlatformDueResponseDto,
} from './dto';
import { FinanceService } from './finance.service';

@ApiTags('Finance')
@Controller('finance')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.SERVICE_MANAGER, Role.ADMIN)
@RequirePermission('invoice:read_related')
@ApiBearerAuth()
export class FinanceController {
  constructor(private readonly financeService: FinanceService) {}

  @Get('platform-dues')
  @ApiOperation({ summary: 'Manager/Admin: list immutable platform due snapshots' })
  @ApiOkResponse({
    description: 'Platform due snapshots returned with pagination metadata',
    type: PlatformDueResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid platform due filters or pagination' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Manager/Admin finance read permission required' })
  async listPlatformDues(@Query() query: PlatformDueQueryDto) {
    const result = await this.financeService.listPlatformDues(query);
    return {
      data: result.data,
      meta: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / query.limit),
      },
    };
  }
}
