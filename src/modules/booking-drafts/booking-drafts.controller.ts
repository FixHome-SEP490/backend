import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RiskLimit } from '../../common/rate-limit/risk-rate-limit';
import { Role } from '../../shared/enums';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { SaveBookingDraftDto, SubmitBookingDraftDto } from './booking-draft.dto';
import { BookingDraftsService } from './booking-drafts.service';

type AuthedRequest = { user: { id: string; role: string } };

@ApiTags('Booking drafts')
@ApiBearerAuth()
@Controller('booking-drafts')
@Roles(Role.CUSTOMER)
@UseGuards(JwtAuthGuard, RolesGuard)
export class BookingDraftsController {
  constructor(private readonly drafts: BookingDraftsService) {}

  @Get('current')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Khách hàng: đọc bản nháp đã lưu, null khi không có hoặc hết hạn' })
  async current(@Req() req: AuthedRequest) {
    return { data: await this.drafts.current(req.user) };
  }

  @Put('current')
  @RiskLimit('booking-draft-write')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Khách hàng: chủ động lưu một bản nháp, gia hạn 30 ngày; không tạo yêu cầu đặt lịch' })
  async save(@Body() dto: SaveBookingDraftDto, @Req() req: AuthedRequest) {
    return { data: await this.drafts.save(dto, req.user) };
  }

  @Delete('current')
  @RiskLimit('booking-draft-write')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Khách hàng: bỏ bản nháp hiện tại, giữ biên nhận đã gửi' })
  async discard(@Req() req: AuthedRequest) {
    return { data: await this.drafts.discard(req.user) };
  }

  @Post(':draftId/submit')
  @HttpCode(200)
  @RiskLimit('booking-create')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Khách hàng: gửi đúng phiên bản bản nháp, gửi lại cùng mã trả biên nhận cũ' })
  async submit(@Param('draftId', ParseUUIDPipe) draftId: string, @Body() dto: SubmitBookingDraftDto, @Req() req: AuthedRequest) {
    return { data: await this.drafts.submit(draftId, dto, req.user) };
  }
}
