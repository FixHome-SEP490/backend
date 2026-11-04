import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { CannotContinueDto } from './dto/technician-report.dto';
import { SupportCaseActor } from './support-cases.service';
import { TechnicianReportService } from './technician-report.service';
import { SoloContactAttemptDto } from './dto/solo-contact.dto';
import { RiskLimit } from '../../common/rate-limit/risk-rate-limit';

@ApiTags('Service Orders')
@ApiBearerAuth()
@Controller('service-orders')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
export class OnsiteInterruptionController {
  constructor(private readonly reports: TechnicianReportService) {}

  @Get(':id/contact-readiness')
  @Header('Cache-Control', 'no-store')
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Read server-recorded solo onsite contact readiness' })
  contactReadiness(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: SupportCaseActor) {
    return this.reports.contactReadiness(id, actor);
  }

  @Post(':id/contact-attempt')
  @RiskLimit('onsite-contact')
  @HttpCode(200)
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:read_related')
  @ApiOperation({ summary: 'Record a solo onsite call attempt or notify the customer' })
  contactAttempt(@Param('id', ParseUUIDPipe) id: string, @Body() body: SoloContactAttemptDto, @CurrentUser() actor: SupportCaseActor) {
    return this.reports.contactAttempt(id, body, actor);
  }

  @Post(':id/cannot-continue')
  @RiskLimit('onsite-stop')
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
