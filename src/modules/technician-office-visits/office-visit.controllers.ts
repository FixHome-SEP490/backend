import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../../common/guards';
import { Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ApproveProfileDto,
  BookOfficeVisitDto,
  CreateVisitOfficeDto,
  MarkOfficeVisitDto,
  QueryOfficeVisitsDto,
  RejectProfileDto,
  UpdateVisitOfficeDto,
} from './dto/office-visit.dto';
import { OfficeVisitsService } from './office-visits.service';
import { ProfileReviewService } from './profile-review.service';

type Req = { user: { id: string } };

@ApiTags('Technician Office Visit')
@Controller('technicians/me/office-visit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.TECHNICIAN)
@ApiBearerAuth()
export class TechnicianOfficeVisitController {
  constructor(private readonly visits: OfficeVisitsService) {}

  @Get()
  @ApiOperation({ summary: 'Technician: current office visit, offices by distance and open slots' })
  getMine(@Req() req: Req) {
    return this.visits.getMine(req.user.id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Technician: book or change the office visit (office + time)' })
  book(@Req() req: Req, @Body() dto: BookOfficeVisitDto) {
    return this.visits.book(req.user.id, dto);
  }
}

@ApiTags('Admin Visit Offices')
@Controller('admin/visit-offices')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminVisitOfficesController {
  constructor(private readonly visits: OfficeVisitsService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: list offices where technicians come to meet' })
  list() {
    return this.visits.listOffices();
  }

  @Post()
  @ApiOperation({ summary: 'Admin: create an office' })
  create(@Body() dto: CreateVisitOfficeDto) {
    return this.visits.createOffice(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Admin: update an office (hours, capacity, active)' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVisitOfficeDto) {
    return this.visits.updateOffice(id, dto);
  }
}

@ApiTags('Admin Office Visits')
@Controller('admin/technician-office-visits')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminOfficeVisitsController {
  constructor(private readonly visits: OfficeVisitsService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: appointments by office, date and status' })
  list(@Query() query: QueryOfficeVisitsDto) {
    return this.visits.listVisits(query);
  }

  @Patch(':id/attended')
  @ApiOperation({ summary: 'Admin: the technician came to the office' })
  attended(@Param('id', ParseUUIDPipe) id: string, @Req() req: Req, @Body() dto: MarkOfficeVisitDto) {
    return this.visits.markAttended(id, req.user.id, dto);
  }

  @Patch(':id/missed')
  @ApiOperation({ summary: 'Admin: the technician did not come' })
  missed(@Param('id', ParseUUIDPipe) id: string, @Req() req: Req, @Body() dto: MarkOfficeVisitDto) {
    return this.visits.markMissed(id, req.user.id, dto);
  }

  @Post('technicians/:technicianId/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin: allow a blocked technician to book again' })
  reset(@Param('technicianId', ParseUUIDPipe) technicianId: string, @Req() req: Req) {
    return this.visits.resetMissed(technicianId, req.user.id);
  }
}

@ApiTags('Admin Profile Reviews')
@Controller('admin/technician-profile-reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminProfileReviewsController {
  constructor(private readonly reviews: ProfileReviewService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: technicians with confirmed identity waiting for the profile review' })
  list() {
    return this.reviews.list();
  }

  @Get(':technicianId')
  @ApiOperation({ summary: 'Admin: profile to review (skills, declared level, certificates, visits)' })
  get(@Param('technicianId', ParseUUIDPipe) technicianId: string) {
    return this.reviews.get(technicianId);
  }

  @Patch(':technicianId/approve')
  @ApiOperation({ summary: 'Admin: final profile approval after the office visit (confirms skill levels)' })
  approve(@Param('technicianId', ParseUUIDPipe) technicianId: string, @Req() req: Req, @Body() dto: ApproveProfileDto) {
    return this.reviews.approve(technicianId, req.user.id, dto);
  }

  @Patch(':technicianId/reject')
  @ApiOperation({ summary: 'Admin: reject the profile with a reason' })
  reject(@Param('technicianId', ParseUUIDPipe) technicianId: string, @Req() req: Req, @Body() dto: RejectProfileDto) {
    return this.reviews.reject(technicianId, req.user.id, dto);
  }
}
