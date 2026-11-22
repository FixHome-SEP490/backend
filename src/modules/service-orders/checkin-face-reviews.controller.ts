import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiConflictResponse, ApiNotFoundResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../../shared/enums';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CheckinFaceReviewService } from './checkin-face-review.service';
import { QueryCheckinFaceReviewsDto, ReviewCheckinFaceDto } from './dto/checkin-face-review.dto';

@ApiTags('Check-in face reviews (service manager)')
@Controller('service-manager/checkin-face-reviews')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.SERVICE_MANAGER, Role.ADMIN)
@RequirePermission('technician:verify')
@ApiBearerAuth()
export class CheckinFaceReviewsController {
  constructor(private readonly service: CheckinFaceReviewService) {}

  @Get()
  @ApiOperation({ summary: 'Manager: technician check-in faces that did not match the registered face' })
  async list(@Query() query: QueryCheckinFaceReviewsDto) {
    const result = await this.service.list(query);
    return {
      data: result.data,
      meta: { page: query.page, limit: query.limit, total: result.total, totalPages: Math.ceil(result.total / query.limit) },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Manager: the check-in photo and the registered face photo (short-lived signed URLs)' })
  @ApiNotFoundResponse({ description: 'No such review' })
  async detail(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.service.detail(id) };
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manager: approve the face, or reject it and ask the technician to retake' })
  @ApiConflictResponse({ description: 'The review is no longer pending' })
  async review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewCheckinFaceDto,
    @Req() req: { user: { id: string } },
  ) {
    await this.service.review(id, req.user.id, body);
    return { data: { id, status: body.approve ? 'approved' : 'rejected' } };
  }
}
