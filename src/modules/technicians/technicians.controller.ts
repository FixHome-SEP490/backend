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
import {
  TechniciansService,
  ScheduleItemDto,
  ServiceAreaItemDto,
} from './technicians.service';
import {
  TechnicianServiceOfferingResponseDto,
  UpdateSkillPricingDto,
} from './dto';

@ApiTags('Technicians')
@Controller('technicians')
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

  @Patch('me/profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update current technician profile' })
  async updateMyProfile(
    @Req() req: { user: { id: string } },
    @Body() dto: { bio?: string; isAvailable?: boolean; yearsExperience?: number },
  ) {
    const profile = await this.techniciansService.updateMyProfile(req.user.id, dto);
    return { data: profile };
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
    @Body() body: { schedules: ScheduleItemDto[] },
  ) {
    const schedule = await this.techniciansService.updateMySchedule(
      req.user.id,
      body.schedules || [],
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
    @Body() dto: { startAt: string; endAt: string; reason?: string },
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
    @Param('id') id: string,
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
    @Body() body: { areas: ServiceAreaItemDto[] },
  ) {
    const areas = await this.techniciansService.updateMyServiceAreas(
      req.user.id,
      body.areas || [],
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
