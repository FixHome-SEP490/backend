import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { AdminReviewsService } from './admin-reviews.service';

/** Admin: customer reviews (PO 09/10/2026). Read only. */
@ApiTags('Admin / Reviews')
@Controller('admin/reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminReviewsController {
  constructor(private readonly service: AdminReviewsService) {}

  @Get()
  @ApiOperation({ summary: 'Admin: reviews, newest first; filter by stars (rating, maxRating) and Vietnam days; search technician, customer, order code or comment' })
  list(
    @Query('search') search?: string,
    @Query('rating') rating?: string,
    @Query('maxRating') maxRating?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list({ search, rating: Number(rating), maxRating: Number(maxRating), from, to, page: Number(page), pageSize: Number(pageSize) });
  }
}
