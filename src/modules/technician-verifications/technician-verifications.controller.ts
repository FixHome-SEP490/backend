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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { TechnicianVerificationsService } from './technician-verifications.service';
import {
  KycSignedAccessResponseDto,
  SubmitVerificationDto,
  TechnicianVerificationResponseDto,
} from './dto';
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
  @ApiCreatedResponse({
    description: 'Verification submitted successfully',
    type: TechnicianVerificationResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid verification documents' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Active technician account required' })
  @ApiConflictResponse({ description: 'Already pending or verified' })
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
  @ApiOkResponse({
    description: 'Verification status fetched successfully',
    type: TechnicianVerificationResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Technician role required' })
  async getMyVerification(@CurrentUser('id') technicianId: string) {
    return this.verificationsService.getMyVerification(technicianId);
  }

  @Get('documents/:documentId/access')
  @ApiOperation({
    summary: 'Technician: Get short-lived access to an own KYC document',
  })
  @ApiOkResponse({
    description: 'Signed private document access returned',
    type: KycSignedAccessResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid document UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Document owner access required' })
  @ApiNotFoundResponse({ description: 'Verification document not found' })
  @ApiServiceUnavailableResponse({
    description: 'Private KYC storage could not issue signed access',
  })
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
