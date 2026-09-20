// src/modules/technician-skill-verifications/technician-skill-verifications.controller.ts
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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TechnicianSkillVerificationsService } from './technician-skill-verifications.service';
import { AttachSkillEvidenceDto } from './dto';
import { KycSignedAccessResponseDto, KycSignedUploadResponseDto, RequestKycUploadUrlDto } from '../technician-verifications/dto';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';

@ApiTags('Technicians')
@Controller('technicians/me/services/:serviceId/verification')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TECHNICIAN)
@ApiBearerAuth()
export class TechnicianSkillVerificationsController {
  constructor(private readonly service: TechnicianSkillVerificationsService) {}

  @Get()
  @ApiOperation({ summary: 'Technician: Get own verification status for a skill' })
  async getMy(
    @CurrentUser('id') technicianId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ) {
    return this.service.getMySkillVerification(technicianId, serviceId);
  }

  @Post('documents/upload-url')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Technician: Request a signed URL to upload a supporting credential' })
  async createUploadUrl(
    @CurrentUser('id') technicianId: string,
    @Body() dto: RequestKycUploadUrlDto,
  ): Promise<KycSignedUploadResponseDto> {
    return this.service.createEvidenceUploadUrl(technicianId, dto.mimeType);
  }

  @Post('documents')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Technician: Attach an outside credential to the pending verification request',
  })
  async attachDocument(
    @CurrentUser('id') technicianId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: AttachSkillEvidenceDto,
  ) {
    return this.service.attachEvidence(technicianId, serviceId, dto);
  }

  @Get('documents/:documentId/access')
  @ApiOperation({ summary: "Technician: Get signed access to one of own skill verification documents" })
  async getDocumentAccess(
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: { id: string; role: Role },
  ): Promise<KycSignedAccessResponseDto> {
    return this.service.getSignedDocumentAccess(documentId, user);
  }
}
