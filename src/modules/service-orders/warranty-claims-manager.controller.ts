import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import {
  ApproveWarrantyProposalDto,
  AssignWarrantyClaimDto,
  CloseWarrantyClaimDto,
  QueryWarrantyClaimsDto,
  QueryWarrantyStatsDto,
  RejectWarrantyClaimDto,
  StaffWarrantyClaimDto,
  TechnicianWarrantyStatDto,
} from './dto/warranty-claim.dto';
import { WarrantyClaimsManagerService } from './warranty-claims-manager.service';

type Req = { user: { id: string; role: string } };

@ApiTags('Warranty Claims (service manager)')
@Controller('service-manager/warranty-claims')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.SERVICE_MANAGER, Role.ADMIN)
@RequirePermission('support:read_all')
@ApiBearerAuth()
export class WarrantyClaimsManagerController {
  constructor(private readonly service: WarrantyClaimsManagerService) {}

  @Get()
  @ApiOperation({ summary: 'Manager: warranty claim queue' })
  @ApiOkResponse({ type: StaffWarrantyClaimDto, isArray: true })
  async list(@Query() query: QueryWarrantyClaimsDto) {
    const result = await this.service.list(query);
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

  @Get('stats/technicians')
  @ApiOperation({ summary: 'Manager: warranty rates per technician' })
  @ApiOkResponse({ type: TechnicianWarrantyStatDto, isArray: true })
  async stats(@Query() query: QueryWarrantyStatsDto) {
    return { data: await this.service.technicianStats(query.windowDays) };
  }

  @Get('eligible-technicians')
  @ApiOperation({ summary: 'Manager: active technicians a claim can be assigned to' })
  async eligibleTechnicians() {
    return { data: await this.service.eligibleTechnicians() };
  }

  @Get(':claimId')
  @ApiOperation({ summary: 'Manager: one warranty claim with order, customer, coverage and visit' })
  @ApiNotFoundResponse({ description: 'Claim not found' })
  async get(@Param('claimId', ParseUUIDPipe) claimId: string) {
    return { data: await this.service.get(claimId) };
  }

  @Post(':claimId/assign')
  @Roles(Role.SERVICE_MANAGER)
  @RequirePermission('support:resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manager: assign or reassign the technician who handles the claim' })
  @ApiConflictResponse({ description: 'Claim is past the inspection stage' })
  async assign(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: AssignWarrantyClaimDto,
    @Req() req: Req,
  ) {
    return { data: await this.service.assign(claimId, dto, req.user) };
  }

  @Post(':claimId/approve')
  @Roles(Role.SERVICE_MANAGER)
  @RequirePermission('support:resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manager: approve the technician proposal, optionally overriding the result' })
  async approve(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: ApproveWarrantyProposalDto,
    @Req() req: Req,
  ) {
    return { data: await this.service.approve(claimId, dto, req.user) };
  }

  @Post(':claimId/reject')
  @Roles(Role.SERVICE_MANAGER)
  @RequirePermission('support:resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manager: reject a claim with a reason shown to the customer' })
  async reject(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: RejectWarrantyClaimDto,
    @Req() req: Req,
  ) {
    return { data: await this.service.reject(claimId, dto, req.user) };
  }

  @Post(':claimId/close')
  @Roles(Role.SERVICE_MANAGER)
  @RequirePermission('support:resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manager: close a claim after the customer answered or the dispute was reviewed' })
  async close(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: CloseWarrantyClaimDto,
    @Req() req: Req,
  ) {
    return { data: await this.service.close(claimId, dto, req.user) };
  }
}
