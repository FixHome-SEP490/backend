// src/modules/technicians/technicians.controller.ts
import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionGuard, RolesGuard } from '../../common/guards';
import { RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateTechnicianProfileDto {
  @IsOptional() @IsString() @MaxLength(2000) bio?: string;
  @IsOptional() @IsBoolean() isAvailable?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(80) yearsExperience?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(40) serviceRadiusKm?: number;
}
/** GPS ping from the technician app while it is open (PO 08/10/2026). */
export class LocationPingDto {
  @IsNumber() @Min(-90) @Max(90) lat: number;
  @IsNumber() @Min(-180) @Max(180) lng: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100000) accuracyMeters?: number;
}
import { TechniciansService } from './technicians.service';
import { CreateTimeOffDto, UpdateScheduleDto, UpdateServiceAreasDto } from './dto/availability.dto';
import {
  TechnicianServiceOfferingResponseDto,
  UpdateSkillPricingDto,
} from './dto';

@ApiTags('Technicians')
@Controller('technicians')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TECHNICIAN)
export class TechniciansController {
  constructor(private readonly techniciansService: TechniciansService) {}

  @Get('me/profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current technician profile' })
  async getMyProfile(@Req() req: { user: { id: string } }) {
    const profile = await this.techniciansService.getMyProfile(req.user.id);
    return { data: profile };
  }

  @Get('me/availability')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Technician: receiving jobs right now? The weekly schedule switches it, the manual switch pauses, time off wins' })
  async getMyAvailability(@Req() req: { user: { id: string } }) {
    return { data: await this.techniciansService.getMyAvailability(req.user.id) };
  }

  @Patch('me/profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update current technician profile' })
  async updateMyProfile(
    @Req() req: { user: { id: string } },
    @Body() dto: UpdateTechnicianProfileDto,
  ) {
    const profile = await this.techniciansService.updateMyProfile(req.user.id, dto);
    return { data: profile };
  }

  @Patch('me/location')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Technician: report current GPS position', description: 'Sent by the app while it is open. A position younger than matching.gps_fresh_minutes is used to offer urgent bookings nearby; otherwise the work address and chosen districts are used. A fix worse than 1 km accuracy is ignored.' })
  async reportLocation(
    @Req() req: { user: { id: string } },
    @Body() dto: LocationPingDto,
  ) {
    return { data: await this.techniciansService.reportLocation(req.user.id, dto) };
  }

  @Get('me/services')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
  @Roles(Role.TECHNICIAN)
  @RequirePermission('service:read')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current technician services & listed pricing' })
  @ApiOkResponse({
    description: 'Own technician service offerings returned',
    type: TechnicianServiceOfferingResponseDto,
    isArray: true,
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Technician role with service read permission required',
  })
  async getMyServices(
    @Req() req: { user: { id: string } },
  ): Promise<TechnicianServiceOfferingResponseDto[]> {
    return this.techniciansService.getMySkills(req.user.id);
  }

  @Put('me/services/:serviceId')
  @UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
  @Roles(Role.TECHNICIAN)
  @RequirePermission('profile:update_own')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Set technician listed labor price & warranty for service' })
  @ApiParam({
    name: 'serviceId',
    format: 'uuid',
    description: 'Canonical service UUID',
  })
  @ApiOkResponse({
    description: 'Technician service offering created or updated',
    type: TechnicianServiceOfferingResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Invalid pricing input, fixed-price override, or inactive service/category',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Technician role with own-profile update permission required',
  })
  @ApiNotFoundResponse({ description: 'Service not found' })
  async setSkillPricing(
    @Req() req: { user: { id: string } },
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() dto: UpdateSkillPricingDto,
  ): Promise<TechnicianServiceOfferingResponseDto> {
    return this.techniciansService.setSkillPricing(req.user.id, serviceId, dto);
  }

  @Get('me/schedule')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current technician working schedules' })
  async getMySchedule(@Req() req: { user: { id: string } }) {
    const schedule = await this.techniciansService.getMySchedule(req.user.id);
    return { data: schedule };
  }

  @Put('me/schedule')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Configure technician weekly working schedule' })
  async updateMySchedule(
    @Req() req: { user: { id: string } },
    @Body() body: UpdateScheduleDto,
  ) {
    const schedule = await this.techniciansService.updateMySchedule(
      req.user.id,
      body.schedules,
    );
    return { data: schedule };
  }

  @Get('me/time-off')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current technician time off dates' })
  async getMyTimeOff(@Req() req: { user: { id: string } }) {
    const timeOff = await this.techniciansService.getMyTimeOff(req.user.id);
    return { data: timeOff };
  }

  @Post('me/time-off')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add a time off interval for technician' })
  async createTimeOff(
    @Req() req: { user: { id: string } },
    @Body() dto: CreateTimeOffDto,
  ) {
    const timeOff = await this.techniciansService.createTimeOff(req.user.id, dto);
    return { data: timeOff };
  }

  @Delete('me/time-off/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a time off entry' })
  async deleteTimeOff(
    @Req() req: { user: { id: string } },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const result = await this.techniciansService.deleteTimeOff(req.user.id, id);
    return { data: result };
  }

  @Get('me/service-areas')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current technician service areas' })
  async getMyServiceAreas(@Req() req: { user: { id: string } }) {
    const areas = await this.techniciansService.getMyServiceAreas(req.user.id);
    return { data: areas };
  }

  @Put('me/service-areas')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update technician service areas' })
  async updateMyServiceAreas(
    @Req() req: { user: { id: string } },
    @Body() body: UpdateServiceAreasDto,
  ) {
    const areas = await this.techniciansService.updateMyServiceAreas(
      req.user.id,
      body.areas,
    );
    return { data: areas };
  }

  @Get('me/earnings')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get technician earnings and settlement breakdown' })
  async getMyEarnings(@Req() req: { user: { id: string } }) {
    const earnings = await this.techniciansService.getMyEarnings(req.user.id);
    return { data: earnings };
  }
}
