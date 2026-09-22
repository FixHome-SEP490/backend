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

// Admin-only by design: FixHome staff issue the certificate in person, no
// regional Service Manager scoping for this review (unlike identity KYC's
// technician:verify permission, which SMs also hold).
@ApiTags('Admin / Technician Skill Verifications')
@Controller('admin/technician-skill-verifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
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
