// src/modules/part-requests/part-requests.controller.ts
import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import { PartRequestsService } from './part-requests.service';
import {
  CreatePartRequestDto,
  ReceivePartRequestDto,
  UpdateItemUsageDto,
  MarkReadyDto,
  MarkDeliveringDto,
  QueryPartRequestsDto,
} from './dto';

@ApiTags('Part Requests')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PartRequestsController {
  constructor(private readonly partRequestsService: PartRequestsService) {}

  // ── 1. Technician: Pre-Repair Parts Request ──

  @Post('service-orders/:orderId/part-requests')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Technician: Create Pre-Repair Parts Request',
    description:
      'Technician selects planned spare parts from FixHome catalog before heading to customer. Order must be ACCEPTED.',
  })
  @ApiCreatedResponse({ description: 'Pre-repair parts request created' })
  @ApiBadRequestResponse({ description: 'Invalid data or part inactive' })
  @ApiForbiddenResponse({ description: 'Not assigned technician' })
  async createPreRepairRequest(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: CreatePartRequestDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const data = await this.partRequestsService.createPreRepairRequest(
      orderId,
      dto,
      req.user,
    );
    return { data };
  }

  // ── 2. List Part Requests for a Service Order ──

  @Get('service-orders/:orderId/part-requests')
  @Roles(Role.TECHNICIAN, Role.SERVICE_MANAGER, Role.ADMIN, Role.CUSTOMER)
  @ApiOperation({
    summary: 'Get all parts requests for a Service Order',
    description:
      'View history of parts requests (pre-repair & additional) for the specified order.',
  })
  @ApiOkResponse({ description: 'List of part requests with items' })
  async getByOrderId(
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const data = await this.partRequestsService.getByOrderId(
      orderId,
      req.user,
    );
    return { data };
  }

  // ── 3. Technician: Receive via QR Scan ──

  @Post('part-requests/:id/receive')
  @Roles(Role.TECHNICIAN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Technician: Confirm parts handover via QR scan',
    description:
      'Technician scans depot/delivery QR token to confirm receiving parts. Validates ownership, status, token match, and expiry.',
  })
  @ApiOkResponse({ description: 'Parts received successfully' })
  @ApiBadRequestResponse({ description: 'Invalid token or wrong status' })
  async receiveByQr(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceivePartRequestDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const data = await this.partRequestsService.receiveByQr(
      id,
      dto,
      req.user,
    );
    return { data };
  }

  // ── 4. Technician: Update Part Item Usage (USED / RETURNED) ──

  @Patch('part-requests/:id/items/:itemId/usage')
  @Roles(Role.TECHNICIAN, Role.ADMIN)
  @ApiOperation({
    summary: 'Technician: Mark part item as USED or RETURNED',
    description:
      'After completing repair, technician marks each received part item as USED or RETURNED. Only USED parts in approved quotation/additional cost are billed to customer.',
  })
  @ApiOkResponse({ description: 'Item usage status updated' })
  async updateItemUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateItemUsageDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const data = await this.partRequestsService.updateItemUsage(
      id,
      itemId,
      dto,
      req.user,
    );
    return { data };
  }

  // ── 5. Cancel Part Request ──

  @Patch('part-requests/:id/cancel')
  @Roles(Role.TECHNICIAN, Role.SERVICE_MANAGER, Role.ADMIN)
  @ApiOperation({
    summary: 'Cancel a parts request',
    description:
      'SM/Admin can cancel any non-terminal request; Technician can only cancel if still REQUESTED.',
  })
  @ApiOkResponse({ description: 'Request cancelled' })
  async cancelPartRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
    @Body('reason') reason?: string,
  ) {
    const data = await this.partRequestsService.cancelPartRequest(
      id,
      req.user,
      reason,
    );
    return { data };
  }

  // ── 6. Service Manager / Admin: Query all Part Requests ──

  @Get('part-requests')
  @Roles(Role.SERVICE_MANAGER, Role.ADMIN, Role.TECHNICIAN)
  @ApiOperation({
    summary: 'List / Filter part requests (SM / Admin oversight)',
    description:
      'Filter by status, serviceOrderId, technicianId with pagination.',
  })
  @ApiOkResponse({ description: 'Paginated list of part requests' })
  async findAll(
    @Query() query: QueryPartRequestsDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const result = await this.partRequestsService.findAll(query, req.user);
    return { data: result.data, meta: { total: result.total } };
  }

  // ── 7. Get Part Request Detail ──

  @Get('part-requests/:id')
  @Roles(Role.SERVICE_MANAGER, Role.ADMIN, Role.TECHNICIAN, Role.CUSTOMER)
  @ApiOperation({ summary: 'Get part request detail by ID' })
  @ApiOkResponse({ description: 'Part request detail with items' })
  @ApiNotFoundResponse({ description: 'Request not found' })
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const data = await this.partRequestsService.getById(id, req.user);
    return { data };
  }

  // ── 8. Service Manager: Mark READY (Generates QR) ──

  @Patch('part-requests/:id/ready')
  @Roles(Role.SERVICE_MANAGER, Role.ADMIN)
  @ApiOperation({
    summary: 'Service Manager: Mark parts READY for pickup/delivery',
    description:
      'SM prepares parts at depot and marks READY, generating a secure QR token for technician handover.',
  })
  @ApiOkResponse({ description: 'Part request marked READY with QR token' })
  async markReady(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkReadyDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const data = await this.partRequestsService.markReady(
      id,
      req.user,
      dto,
    );
    return { data };
  }

  // ── 9. Service Manager: Mark DELIVERING ──

  @Patch('part-requests/:id/delivering')
  @Roles(Role.SERVICE_MANAGER, Role.ADMIN)
  @ApiOperation({
    summary: 'Service Manager: Mark DELIVERY parts as DELIVERING',
    description:
      'For DELIVERY fulfillment: SM dispatches parts to technician location.',
  })
  @ApiOkResponse({ description: 'Part request marked DELIVERING' })
  async markDelivering(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarkDeliveringDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const data = await this.partRequestsService.markDelivering(
      id,
      req.user,
      dto,
    );
    return { data };
  }
}
