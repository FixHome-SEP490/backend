import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import {
  CreateWarrantyClaimDto,
  RespondWarrantyClaimDto,
  WarrantyClaimViewDto,
} from './dto/warranty-claim.dto';
import { WarrantyClaimsService } from './warranty-claims.service';

type Req = { user: { id: string; role: string } };

@ApiTags('Warranty Claims')
@Controller()
@ApiBearerAuth()
export class WarrantyClaimsController {
  constructor(private readonly claimsService: WarrantyClaimsService) {}

  @Post('service-orders/:id/warranty-claims')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
  @Roles(Role.CUSTOMER)
  @RequirePermission('order:read_related')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Customer: submit a warranty claim for one warranty coverage' })
  @ApiCreatedResponse({ type: WarrantyClaimViewDto })
  @ApiConflictResponse({ description: 'The coverage already has an open claim' })
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWarrantyClaimDto,
    @Req() req: Req,
  ) {
    return { data: await this.claimsService.create(id, dto, req.user) };
  }

  @Get('service-orders/:id/warranty-claims')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'List warranty claims of an order' })
  @ApiOkResponse({ type: WarrantyClaimViewDto, isArray: true })
  async list(@Param('id', ParseUUIDPipe) id: string, @Req() req: Req) {
    return { data: await this.claimsService.list(id, req.user) };
  }

  @Post('service-orders/:id/warranty-claims/:claimId/respond')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
  @Roles(Role.CUSTOMER)
  @RequirePermission('order:read_related')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Customer: agree with or dispute the warranty decision' })
  @ApiOkResponse({ type: WarrantyClaimViewDto })
  @ApiNotFoundResponse({ description: 'Claim not found' })
  @ApiConflictResponse({ description: 'The claim is not waiting for the customer' })
  async respond(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('claimId', ParseUUIDPipe) claimId: string,
    @Body() dto: RespondWarrantyClaimDto,
    @Req() req: Req,
  ) {
    return { data: await this.claimsService.respond(id, claimId, dto, req.user) };
  }
}
