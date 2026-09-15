// src/modules/technician-verifications/admin-technician-verifications.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { TechnicianVerificationsService } from './technician-verifications.service';
import {
  KycSignedAccessResponseDto,
  QueryVerificationsDto,
  RejectVerificationDto,
  TechnicianVerificationResponseDto,
} from './dto';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';

@ApiTags('Admin / Technician Verifications')
@Controller('admin/technician-verifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminTechnicianVerificationsController {
  constructor(
    private readonly verificationsService: TechnicianVerificationsService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Admin: List all technician verification requests' })
  @ApiOkResponse({
    description: 'List of verifications fetched successfully',
    type: TechnicianVerificationResponseDto,
    isArray: true,
  })
  @ApiBadRequestResponse({ description: 'Invalid verification filters or pagination' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin role required' })
  async findAll(@Query() query: QueryVerificationsDto) {
    return this.verificationsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: View details of a verification request' })
  @ApiOkResponse({
    description: 'Verification detail fetched successfully',
    type: TechnicianVerificationResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid verification UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin role required' })
  @ApiNotFoundResponse({ description: 'Verification not found' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.verificationsService.findById(id);
  }

  @Get(':id/documents/:documentId/access')
  @ApiOperation({
    summary: 'Admin: Get short-lived access to a private KYC document',
  })
  @ApiOkResponse({
    description: 'Signed private document access returned',
    type: KycSignedAccessResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid verification or document UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin role required' })
  @ApiNotFoundResponse({ description: 'Verification document not found' })
  @ApiServiceUnavailableResponse({
    description: 'Private KYC storage could not issue signed access',
  })
  async getDocumentAccess(
    @Param('id', ParseUUIDPipe) verificationId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: { id: string; role: Role },
  ) {
    return this.verificationsService.getSignedDocumentAccess(
      documentId,
      user,
      verificationId,
    );
  }

  @Patch(':id/approve')
  @ApiOperation({ summary: 'Admin: Approve technician verification request' })
  @ApiOkResponse({
    description: 'Verification approved successfully',
    type: TechnicianVerificationResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid verification UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin role required' })
  @ApiNotFoundResponse({ description: 'Verification not found' })
  @ApiConflictResponse({ description: 'Already processed' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') reviewerId: string,
  ) {
    return this.verificationsService.approveVerification(id, reviewerId);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Admin: Reject technician verification request' })
  @ApiOkResponse({
    description: 'Verification rejected successfully',
    type: TechnicianVerificationResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid verification UUID or rejection reason' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Admin role required' })
  @ApiNotFoundResponse({ description: 'Verification not found' })
  @ApiConflictResponse({ description: 'Already processed' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') reviewerId: string,
    @Body() dto: RejectVerificationDto,
  ) {
    return this.verificationsService.rejectVerification(id, reviewerId, dto);
  }
}
