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
import { IsEnum, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, WarrantyClaimStatus } from '../../shared/enums';
import {
  AcceptWarrantyClaimDto,
  CheckInWarrantyVisitDto,
  CompleteWarrantyReServiceDto,
  DeclineWarrantyClaimDto,
  ProposeWarrantyInspectionDto,
  StaffWarrantyClaimDto,
} from './dto/warranty-claim.dto';
import { WarrantyClaimsTechnicianService } from './warranty-claims-technician.service';

class QueryMyWarrantyClaimsDto {
  @IsOptional()
  @IsEnum(WarrantyClaimStatus)
  status?: WarrantyClaimStatus;
}

type Req = { user: { id: string; role: string } };

@ApiTags('Warranty Claims (technician)')
@Controller('warranty-claims')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.TECHNICIAN)
@RequirePermission('order:read_related')
@ApiBearerAuth()
export class WarrantyClaimsTechnicianController {
  constructor(private readonly service: WarrantyClaimsTechnicianService) {}

  @Get('mine')
  @ApiOperation({ summary: 'Technician: warranty claims assigned to me' })
  @ApiOkResponse({ type: StaffWarrantyClaimDto, isArray: true })
  async mine(@Query() query: QueryMyWarrantyClaimsDto, @Req() req: Req) {
    return { data: await this.service.listMine(req.user, query.status) };
  }

  @Post(':claimId/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Technician: take the claim and schedule an inspection' })
  @ApiNotFoundResponse({ description: 'Claim is not assigned to the caller' })
  @ApiConflictResponse({ description: 'Claim is not waiting to be accepted' })
  async accept(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: AcceptWarrantyClaimDto,
    @Req() req: Req,
  ) {
    return { data: await this.service.accept(claimId, dto, req.user) };
  }

  @Post(':claimId/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Technician: cannot take the claim; the service manager reassigns it' })
  async decline(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: DeclineWarrantyClaimDto,
    @Req() req: Req,
  ) {
    return { data: await this.service.decline(claimId, dto, req.user) };
  }

  @Post(':claimId/check-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Technician: confirm arrival for the inspection visit' })
  async checkIn(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: CheckInWarrantyVisitDto,
    @Req() req: Req,
  ) {
    return { data: await this.service.checkIn(claimId, dto, req.user) };
  }

  @Post(':claimId/propose')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Technician: propose the inspection conclusion for manager approval' })
  async propose(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: ProposeWarrantyInspectionDto,
    @Req() req: Req,
  ) {
    return { data: await this.service.propose(claimId, dto, req.user) };
  }

  @Post(':claimId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Technician: report the free re-service as done' })
  async complete(
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: CompleteWarrantyReServiceDto,
    @Req() req: Req,
  ) {
    return { data: await this.service.complete(claimId, dto, req.user) };
  }
}
