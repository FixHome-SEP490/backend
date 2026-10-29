import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../../shared/enums';
import { PageSizeQueryDto } from '../../shared/dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PartReturnDiscrepancyDto, PartReturnDto } from './dto/part-return.dto';
import { PartCustodyService } from './part-custody.service';
import { PartCustodyActor } from './part-custody.types';
import { LegacyManualReviewDto } from './dto/legacy-manual-review.dto';

@ApiTags('Part Returns')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class PartReturnsController {
  constructor(private readonly custody: PartCustodyService) {}

  @Get('service-orders/:orderId/part-returns')
  @Roles(Role.TECHNICIAN, Role.SERVICE_MANAGER)
  async byOrder(@Param('orderId', ParseUUIDPipe) orderId: string, @Req() req: { user: PartCustodyActor }) {
    return { data: await this.custody.byOrder(orderId, req.user) };
  }

  @Get('part-returns/pending')
  @Roles(Role.SERVICE_MANAGER)
  async pending(@Req() req: { user: PartCustodyActor }) {
    return { data: await this.custody.pending(req.user) };
  }

  @Get('part-returns/legacy-manual-review')
  @Roles(Role.SERVICE_MANAGER)
  async legacyManualReview(@Query() query: PageSizeQueryDto, @Req() req: { user: PartCustodyActor }) {
    const result = await this.custody.legacyManualReview(req.user, query.page, query.pageSize);
    return { data: result.data, meta: { total: result.total, page: result.page, pageSize: result.pageSize } };
  }

  @Get('part-returns/mine')
  @Roles(Role.TECHNICIAN)
  async mine(@Req() req: { user: PartCustodyActor }) {
    return { data: await this.custody.pending(req.user) };
  }

  @Post('part-returns/legacy-manual-review/:itemId')
  @HttpCode(200)
  @Roles(Role.SERVICE_MANAGER)
  async reviewLegacyItem(@Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: LegacyManualReviewDto, @Req() req: { user: PartCustodyActor }) {
    return { data: await this.custody.reviewLegacyItem(itemId, body, req.user) };
  }

  @Post('part-requests/:requestId/items/:itemId/return-discrepancy')
  @HttpCode(200)
  @Roles(Role.SERVICE_MANAGER)
  async discrepancy(@Param('requestId', ParseUUIDPipe) requestId: string, @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: PartReturnDiscrepancyDto, @Req() req: { user: PartCustodyActor }) {
    return { data: await this.custody.command(requestId, itemId, 'report_discrepancy', body, req.user) };
  }

  @Post('part-requests/:requestId/items/:itemId/declare-return')
  @HttpCode(200)
  @Roles(Role.TECHNICIAN)
  async declare(@Param('requestId', ParseUUIDPipe) requestId: string, @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: PartReturnDto, @Req() req: { user: PartCustodyActor }) {
    return { data: await this.custody.command(requestId, itemId, 'declare_return', body, req.user) };
  }

  @Post('part-requests/:requestId/items/:itemId/accept-return')
  @HttpCode(200)
  @Roles(Role.SERVICE_MANAGER)
  async accept(@Param('requestId', ParseUUIDPipe) requestId: string, @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() body: PartReturnDto, @Req() req: { user: PartCustodyActor }) {
    return { data: await this.custody.command(requestId, itemId, 'accept_return', body, req.user) };
  }
}
