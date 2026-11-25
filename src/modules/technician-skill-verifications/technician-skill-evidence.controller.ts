// src/modules/technician-skill-verifications/technician-skill-evidence.controller.ts
import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TechnicianSkillVerificationsService } from './technician-skill-verifications.service';
import { SubmitCategoryEvidenceDto } from './dto';
import { KycSignedUploadResponseDto, RequestKycUploadUrlDto } from '../technician-verifications/dto';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';

// Evidence that covers several service categories at once; the per-service routes stay in
// TechnicianSkillVerificationsController.
@ApiTags('Technicians')
@Controller('technicians/me/skill-evidence')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TECHNICIAN)
@ApiBearerAuth()
export class TechnicianSkillEvidenceController {
  constructor(private readonly service: TechnicianSkillVerificationsService) {}

  @Post('upload-url')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Technician: Request a signed URL to upload a paper that covers several service categories' })
  async createUploadUrl(
    @CurrentUser('id') technicianId: string,
    @Body() dto: RequestKycUploadUrlDto,
  ): Promise<KycSignedUploadResponseDto> {
    return this.service.createEvidenceUploadUrl(technicianId, dto.mimeType);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Technician: Attach one uploaded paper to every skill the technician has in the chosen service categories',
  })
  async attach(@CurrentUser('id') technicianId: string, @Body() dto: SubmitCategoryEvidenceDto) {
    return this.service.attachEvidenceToCategories(technicianId, dto);
  }
}
