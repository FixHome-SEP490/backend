import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { KycSignedAccessResponseDto, RejectVerificationDto } from '../technician-verifications/dto';
import { QueryCustomerVerificationsDto } from './dto/customer-verification.dto';
import { CustomerVerificationsService } from './customer-verifications.service';

/** Admin only, as for technician KYC (BRX-041): a Service Manager cannot review. */
@ApiTags('Admin / Customer verifications')
@Controller('admin/customer-verifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminCustomerVerificationsController {
  constructor(private readonly service: CustomerVerificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Admin: danh sách hồ sơ xác minh của khách hàng',
    description: 'Lọc status; search theo tên (không dấu), email, số điện thoại, số CCCD (phần đầu).',
  })
  list(@Query() query: QueryCustomerVerificationsDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Admin: chi tiết một hồ sơ xác minh của khách hàng' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }

  @Get(':id/documents/:documentId/access')
  @ApiOperation({ summary: 'Admin: URL ngắn hạn để xem ảnh CCCD của hồ sơ' })
  @ApiOkResponse({ type: KycSignedAccessResponseDto })
  documentAccess(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.service.documentAccess(id, documentId);
  }

  @Patch(':id/approve')
  @ApiOperation({ summary: 'Admin: duyệt hồ sơ, chốt họ tên đã xác minh và báo khách hàng' })
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') reviewerId: string) {
    return this.service.approve(id, reviewerId);
  }

  @Patch(':id/reject')
  @ApiOperation({ summary: 'Admin: từ chối hồ sơ kèm lý do (tối thiểu 5 ký tự) và báo khách hàng' })
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') reviewerId: string,
    @Body() dto: RejectVerificationDto,
  ) {
    return this.service.reject(id, reviewerId, dto.rejectionReason);
  }
}
