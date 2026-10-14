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
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/decorators';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { Role } from '../../shared/enums';
import {
  KycSignedAccessResponseDto,
  KycSignedUploadResponseDto,
} from '../technician-verifications/dto';
import {
  RequestCustomerKycUploadUrlDto,
  SubmitCustomerVerificationDto,
} from './dto/customer-verification.dto';
import { CustomerVerificationsService } from './customer-verifications.service';

/**
 * Customer: identity verification needed to withdraw the wallet
 * (PO 14/10/2026). Upload both sides of the citizen ID card through the signed
 * upload URLs, then submit the details as printed on the card.
 */
@ApiTags('Customer / Identity verification')
@Controller('customer/verification')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.CUSTOMER)
@ApiBearerAuth()
export class CustomerVerificationsController {
  constructor(private readonly service: CustomerVerificationsService) {}

  @Get()
  @RequirePermission('profile:read_own')
  @ApiOperation({
    summary: 'Khách hàng: trạng thái xác minh danh tính (none, pending, verified, rejected) và hồ sơ đã gửi',
  })
  getMine(@CurrentUser('id') userId: string) {
    return this.service.getMine(userId);
  }

  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('profile:update_own')
  @ApiOperation({ summary: 'Khách hàng: lấy URL tải ảnh CCCD lên kho riêng (chỉ JPG, PNG, WEBP)' })
  @ApiOkResponse({ type: KycSignedUploadResponseDto })
  uploadUrl(@CurrentUser('id') userId: string, @Body() dto: RequestCustomerKycUploadUrlDto) {
    return this.service.createUploadUrl(userId, dto);
  }

  @Post()
  @RequirePermission('profile:update_own')
  @ApiOperation({
    summary: 'Khách hàng: gửi hồ sơ xác minh (họ tên, ngày sinh, giới tính, số CCCD, địa chỉ, ảnh hai mặt CCCD)',
    description: 'Thông tin xác nhận được ghi vào hồ sơ cá nhân. Đang chờ duyệt hoặc đã duyệt thì không gửi lại được.',
  })
  submit(@CurrentUser('id') userId: string, @Body() dto: SubmitCustomerVerificationDto) {
    return this.service.submit(userId, dto);
  }

  @Get('documents/:documentId/access')
  @RequirePermission('profile:read_own')
  @ApiOperation({ summary: 'Khách hàng: xem lại ảnh CCCD mình đã gửi (URL ngắn hạn)' })
  @ApiOkResponse({ type: KycSignedAccessResponseDto })
  documentAccess(
    @CurrentUser('id') userId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.service.getMyDocumentAccess(userId, documentId);
  }
}
