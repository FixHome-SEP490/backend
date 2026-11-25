// src/modules/technician-skill-verifications/admin-technician-skill-verifications.controller.ts
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TechnicianSkillVerificationsService } from './technician-skill-verifications.service';
import { AttachSkillEvidenceDto, QuerySkillVerificationsDto, RejectSkillVerificationDto } from './dto';
import { KycSignedAccessResponseDto, KycSignedUploadResponseDto, RequestKycUploadUrlDto } from '../technician-verifications/dto';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';

// Service Manager decides (certificate, approve, reject); Admin only reads.
@ApiTags('Admin / Technician Skill Verifications')
@Controller('admin/technician-skill-verifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.SERVICE_MANAGER)
@ApiBearerAuth()
export class AdminTechnicianSkillVerificationsController {
  constructor(private readonly service: TechnicianSkillVerificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: List technician skill verification requests' })
  async findAll(@Query() query: QuerySkillVerificationsDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: View a skill verification request' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.findById(id);
  }

  @Get(':id/documents/:documentId/access')
  @ApiOperation({ summary: 'Admin: Get signed access to a submitted or issued document' })
  async getDocumentAccess(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: { id: string; role: Role },
  ): Promise<KycSignedAccessResponseDto> {
    return this.service.getSignedDocumentAccess(documentId, user);
  }

  @Roles(Role.SERVICE_MANAGER)
  @Post(':id/certificate-upload-url')
  @ApiOperation({
    summary: "Admin: Request a signed URL to upload the certificate FixHome issues on approval",
  })
  async createCertificateUploadUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RequestKycUploadUrlDto,
  ): Promise<KycSignedUploadResponseDto> {
    return this.service.createCertificateUploadUrl(id, dto.mimeType);
  }

  @Roles(Role.SERVICE_MANAGER)
  @Patch(':id/approve')
  @ApiOperation({
    summary: 'Admin: Approve a skill verification, attaching the certificate FixHome issued',
  })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') reviewerId: string,
    @Body() dto: AttachSkillEvidenceDto,
  ) {
    return this.service.approve(id, reviewerId, dto);
  }

  @Roles(Role.SERVICE_MANAGER)
  @Patch(':id/reject')
  @ApiOperation({ summary: 'Admin: Reject a skill verification request' })
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') reviewerId: string,
    @Body() dto: RejectSkillVerificationDto,
  ) {
    return this.service.reject(id, reviewerId, dto);
  }
}
