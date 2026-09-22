// src/modules/technician-assignment/technician-assignment.controller.ts
import {
  Controller,
  ParseUUIDPipe,
  Post,
  Param,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { TechnicianAssignmentService } from './technician-assignment.service';
import { AssignByOrderDto, AssignByTechnicianDto, AssignByBookingDto } from './assignment.dto';

@ApiTags('Technician Assignment')
@Controller()
export class TechnicianAssignmentController {
  constructor(
    private readonly technicianAssignmentService: TechnicianAssignmentService,
  ) {}

  @Post('technicians/:id/assign')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('assignment:override')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Manually override / assign technician to a service order (SM, Admin)',
  })
  async assignTechnician(
    @Param('id', ParseUUIDPipe) technicianId: string,
    @Body() body: AssignByTechnicianDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const assignment = await this.technicianAssignmentService.overrideAssign(
      technicianId,
      body.orderId,
      req.user,
      body.reason,
    );
    return { data: assignment };
  }

  @Post('service-orders/:id/assign')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('assignment:override')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Assign technician to service order by order ID (SM, Admin)',
  })
  async assignByOrder(
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() body: AssignByOrderDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const assignment = await this.technicianAssignmentService.overrideAssign(
      body.technicianId,
      orderId,
      req.user,
      body.reason,
    );
    return { data: assignment };
  }

  @Post('bookings/:id/assign')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('assignment:override')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Manually assign the first technician to a Booking that has exhausted sequential invitations (SM, Admin)',
  })
  async assignToBooking(
    @Param('id', ParseUUIDPipe) bookingId: string,
    @Body() body: AssignByBookingDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const result = await this.technicianAssignmentService.assignToBooking(
      bookingId,
      body.technicianId,
      req.user,
      body.reason,
    );
    return { data: result };
  }
}
