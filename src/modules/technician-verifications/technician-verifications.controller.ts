// src/modules/technician-verifications/technician-verifications.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { TechnicianVerificationsService } from './technician-verifications.service';
import { SubmitVerificationDto } from './dto';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';

@ApiTags('Technician Verification')
@Controller(['technicians/me/verification', 'technician/verification'])
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TECHNICIAN)
@ApiBearerAuth()
export class TechnicianVerificationsController {
  constructor(
    private readonly verificationsService: TechnicianVerificationsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Technician: Submit verification request with document metadata',
  })
  @ApiResponse({
    status: 201,
    description: 'Verification submitted successfully',
  })
  @ApiResponse({ status: 409, description: 'Already pending or verified' })
  async submit(
    @CurrentUser('id') technicianId: string,
    @Body() dto: SubmitVerificationDto,
  ) {
    return this.verificationsService.submitVerification(technicianId, dto);
  }

  @Get(['', 'status'])
  @ApiOperation({
    summary: 'Technician: Get own verification status and history',
  })
  @ApiResponse({
    status: 200,
    description: 'Verification status fetched successfully',
  })
  async getMyVerification(@CurrentUser('id') technicianId: string) {
    return this.verificationsService.getMyVerification(technicianId);
  }

  @Get('documents/:documentId/access')
  @ApiOperation({
    summary: 'Technician: Get short-lived access to an own KYC document',
  })
  @ApiResponse({
    status: 200,
    description: 'Signed private document access returned',
  })
  @ApiResponse({ status: 403, description: 'Document owner access required' })
  async getDocumentAccess(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: { id: string; role: Role },
  ) {
    return this.verificationsService.getSignedDocumentAccess(
      documentId,
      user,
    );
  }
}
