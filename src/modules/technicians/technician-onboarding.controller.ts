// src/modules/technicians/technician-onboarding.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards';
import { Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { TechnicianOnboardingService } from './technician-onboarding.service';
import {
  SavePersonalInfoDto,
  SaveSkillsDto,
  SaveAddressDto,
  OnboardingStatusResponseDto,
} from './dto';

@ApiTags('Technician Onboarding')
@Controller('technicians/onboarding')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TECHNICIAN)
@ApiBearerAuth()
export class TechnicianOnboardingController {
  constructor(
    private readonly onboardingService: TechnicianOnboardingService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get current onboarding status and progress' })
  @ApiOkResponse({ type: OnboardingStatusResponseDto })
  @ApiForbiddenResponse({ description: 'Technician account required' })
  async getStatus(
    @Req() req: { user: { id: string } },
  ): Promise<OnboardingStatusResponseDto> {
    return this.onboardingService.getOnboardingStatus(req.user.id);
  }

  @Post('personal-info')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 1: Save personal information (name, DOB, gender, CCCD)',
  })
  @ApiOkResponse({ type: OnboardingStatusResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error' })
  async savePersonalInfo(
    @Req() req: { user: { id: string } },
    @Body() dto: SavePersonalInfoDto,
  ): Promise<OnboardingStatusResponseDto> {
    return this.onboardingService.savePersonalInfo(req.user.id, dto);
  }

  // Step 2 (KYC) reuses existing technician-verifications endpoints:
  // POST /technician-verifications/upload-url
  // POST /technician-verifications/submit

  @Post('skills')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 3: Save specialized skills and experience',
  })
  @ApiOkResponse({ type: OnboardingStatusResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error' })
  async saveSkills(
    @Req() req: { user: { id: string } },
    @Body() dto: SaveSkillsDto,
  ): Promise<OnboardingStatusResponseDto> {
    return this.onboardingService.saveSkills(req.user.id, dto);
  }

  @Post('address')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 4: Save address and service areas',
  })
  @ApiOkResponse({ type: OnboardingStatusResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error' })
  async saveAddress(
    @Req() req: { user: { id: string } },
    @Body() dto: SaveAddressDto,
  ): Promise<OnboardingStatusResponseDto> {
    return this.onboardingService.saveAddress(req.user.id, dto);
  }

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Step 5: Submit onboarding for admin review',
  })
  @ApiOkResponse({ type: OnboardingStatusResponseDto })
  @ApiBadRequestResponse({
    description: 'One or more steps not completed',
  })
  async submit(
    @Req() req: { user: { id: string } },
  ): Promise<OnboardingStatusResponseDto> {
    return this.onboardingService.submitOnboarding(req.user.id);
  }
}
