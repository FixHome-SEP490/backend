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
  ApiExtraModels,
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
import {
  AccountStatus,
  DocumentType,
  Role,
  VerificationStatus,
} from '../../shared/enums';

const technicianVerificationNullableSchema = {
  type: 'object',
  nullable: true,
  required: [
    'id',
    'technicianId',
    'status',
    'submittedAt',
    'reviewedAt',
    'reviewedById',
    'rejectionReason',
    'documents',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    technicianId: { type: 'string', format: 'uuid' },
    status: {
      type: 'string',
      enum: Object.values(VerificationStatus),
      example: VerificationStatus.PENDING,
    },
    submittedAt: { type: 'string', format: 'date-time' },
    reviewedAt: { type: 'string', format: 'date-time', nullable: true },
    reviewedById: { type: 'string', format: 'uuid', nullable: true },
    rejectionReason: { type: 'string', nullable: true },
    documents: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'id',
          'verificationId',
          'documentType',
          'fileName',
          'fileSize',
          'mimeType',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          verificationId: { type: 'string', format: 'uuid' },
          documentType: {
            type: 'string',
            enum: Object.values(DocumentType),
            example: DocumentType.CITIZEN_ID_FRONT,
          },
          fileName: { type: 'string', example: 'citizen_id_front.jpg' },
          fileSize: { type: 'integer', minimum: 1, example: 1048576 },
          mimeType: { type: 'string', example: 'image/jpeg' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    technician: {
      type: 'object',
      required: ['id', 'email', 'fullName', 'role', 'status', 'isActive'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string', example: 'tech@example.com' },
        fullName: { type: 'string', example: 'Nguyen Van A' },
        role: {
          type: 'string',
          enum: Object.values(Role),
          example: Role.TECHNICIAN,
        },
        status: {
          type: 'string',
          enum: Object.values(AccountStatus),
          example: AccountStatus.ACTIVE,
        },
        isActive: { type: 'boolean', example: true },
        avatarUrl: { type: 'string', nullable: true },
      },
    },
    reviewedBy: {
      type: 'object',
      nullable: true,
      required: ['id', 'email', 'fullName', 'role', 'status', 'isActive'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string', example: 'tech@example.com' },
        fullName: { type: 'string', example: 'Nguyen Van A' },
        role: {
          type: 'string',
          enum: Object.values(Role),
          example: Role.TECHNICIAN,
        },
        status: {
          type: 'string',
          enum: Object.values(AccountStatus),
          example: AccountStatus.ACTIVE,
        },
        isActive: { type: 'boolean', example: true },
        avatarUrl: { type: 'string', nullable: true },
      },
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
};

@ApiTags('Technician Verification')
@Controller(['technicians/me/verification', 'technician/verification'])
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TECHNICIAN)
@ApiBearerAuth()
@ApiExtraModels(TechnicianVerificationResponseDto)
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
    schema: technicianVerificationNullableSchema,
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
    return this.verificationsService.getSignedDocumentAccess(documentId, user);
  }
}
