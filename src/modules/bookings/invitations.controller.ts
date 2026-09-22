// src/modules/bookings/invitations.controller.ts
import {
  Controller,
  ParseUUIDPipe,
  Get,
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
import { InvitationResponseDto } from './booking.dto';
import { InvitationsService } from './invitations.service';
import { toBookingInvitationResponse } from './booking-privacy.dto';

@ApiTags('Invitations')
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitationsService: InvitationsService) {}

  @Get('my')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('invitation:respond')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get my pending invitations (Technician inbox)' })
  async getMyInvitations(@Req() req: { user: { id: string } }) {
    const invitations = await this.invitationsService.getMyInvitations(
      req.user.id,
    );
    return { data: invitations };
  }

  @Post(':id/respond')
  @UseGuards(JwtAuthGuard, PermissionGuard)
  @RequirePermission('invitation:respond')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Technician: accept or decline the current invitation',
    description: 'Only the invited technician with a live PENDING invitation may respond. ACCEPT creates one ServiceOrder and cancels standby. DECLINE activates the next eligible technician in the customer-selected order. An expired, standby or already-taken invitation cannot be accepted.',
  })
  async respond(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: InvitationResponseDto,
    @Req() req: { user: { id: string; role: string } },
  ) {
    const result = await this.invitationsService.respond(
      id,
      body.action,
      req.user,
    );
    return { data: { ...result, invitation: toBookingInvitationResponse(result.invitation) } };
  }
}
