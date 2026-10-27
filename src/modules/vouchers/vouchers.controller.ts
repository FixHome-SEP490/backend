import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
  ApiOkResponse,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role } from '../../shared/enums';
import {
  ApplyVoucherDto,
  ClaimVoucherDto,
  CreateVoucherCampaignDto,
  GrantPersonalVoucherDto,
  VoucherCampaignStatusDto,
} from './dto/voucher.dto';
import { VoucherActor } from './voucher.types';
import { VouchersService } from './vouchers.service';
import {
  CustomerVoucherClaimDto,
  CustomerGeneralVoucherDto,
  CustomerVoucherReservationDto,
} from './dto/customer-voucher-response.dto';

@ApiTags('Vouchers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('vouchers')
export class VouchersController {
  constructor(
    @Inject(VouchersService) private readonly vouchers: VouchersService,
  ) {}

  @Post('campaigns')
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Tạo chương trình ưu đãi với chính sách bất biến' })
  createCampaign(
    @CurrentUser() actor: VoucherActor,
    @Body() dto: CreateVoucherCampaignDto,
  ) {
    return this.vouchers.createCampaign(actor, dto);
  }

  @Get('campaigns')
  @Roles(Role.ADMIN)
  listCampaigns(@CurrentUser() actor: VoucherActor) {
    return this.vouchers.listCampaigns(actor);
  }

  @Patch('campaigns/:id/status')
  @Roles(Role.ADMIN)
  setCampaignActive(
    @CurrentUser() actor: VoucherActor,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: VoucherCampaignStatusDto,
  ) {
    return this.vouchers.setCampaignActive(actor, id, dto.active);
  }

  @Post('campaigns/:id/grants')
  @Roles(Role.ADMIN)
  @ApiCreatedResponse({ type: CustomerVoucherClaimDto })
  grantPersonal(
    @CurrentUser() actor: VoucherActor,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: GrantPersonalVoucherDto,
  ) {
    return this.vouchers.grantPersonal(actor, id, dto);
  }

  @Get('general')
  @Roles(Role.CUSTOMER)
  @ApiOkResponse({ type: CustomerGeneralVoucherDto, isArray: true })
  browseGeneral(@CurrentUser() actor: VoucherActor) {
    return this.vouchers.browseGeneral(actor);
  }

  @Get('wallet')
  @Roles(Role.CUSTOMER)
  @ApiOkResponse({ type: CustomerVoucherClaimDto, isArray: true })
  wallet(@CurrentUser() actor: VoucherActor) {
    return this.vouchers.wallet(actor);
  }

  @Get('checkout-preview/:claimId/:scopeId')
  @Roles(Role.CUSTOMER)
  @ApiOperation({ summary: 'Xem trước giá ưu đãi từ hóa đơn đã chốt; chưa cho phép thanh toán bằng ưu đãi' })
  checkoutPreview(
    @CurrentUser() actor: VoucherActor,
    @Param('claimId', new ParseUUIDPipe({ version: '4' })) claimId: string,
    @Param('scopeId', new ParseUUIDPipe({ version: '4' })) scopeId: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (Object.keys(query).length > 0) {
      throw new BadRequestException('Không gửi số tiền hoặc tham số vào bản xem trước ưu đãi.');
    }
    return this.vouchers.checkoutPreview(actor, claimId, scopeId);
  }

  @Post('claim')
  @Roles(Role.CUSTOMER)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiCreatedResponse({ type: CustomerVoucherClaimDto })
  claim(@CurrentUser() actor: VoucherActor, @Body() dto: ClaimVoucherDto) {
    return this.vouchers.claim(actor, dto.code);
  }

  @Post('apply')
  @Roles(Role.CUSTOMER)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiCreatedResponse({ type: CustomerVoucherReservationDto })
  apply(@CurrentUser() actor: VoucherActor, @Body() dto: ApplyVoucherDto) {
    return this.vouchers.apply(actor, dto);
  }

  @Post('reservations/:id/release')
  @Roles(Role.CUSTOMER)
  @ApiCreatedResponse({ type: CustomerVoucherReservationDto })
  release(
    @CurrentUser() actor: VoucherActor,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.vouchers.release(actor, id);
  }
  // No HTTP issue, redeem, settle or provider-pending endpoint.
}
