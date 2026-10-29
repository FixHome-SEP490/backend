import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { CannotContinueDto } from './dto/technician-report.dto';
import { SupportCaseActor } from './support-cases.service';
import { TechnicianReportService } from './technician-report.service';

@ApiTags('Service Orders')
@ApiBearerAuth()
@Controller('service-orders')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
export class OnsiteInterruptionController {
  constructor(private readonly reports: TechnicianReportService) {}

  @Post(':id/cannot-continue')
  @HttpCode(200)
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Record a verified onsite interruption without changing old money or physical returns' })
  cannotContinue(@Param('id', ParseUUIDPipe) id: string, @Body() body: CannotContinueDto, @CurrentUser() actor: SupportCaseActor) {
    return this.reports.cannotContinue(id, body, actor);
  }

  @Get(':id/customer-continuation')
  @Header('Cache-Control', 'no-store')
  @Roles(Role.CUSTOMER)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Customer: read verified continuation eligibility independently of manager case status' })
  customerContinuation(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: SupportCaseActor) {
    return this.reports.customerContinuation(id, actor);
  }
}
