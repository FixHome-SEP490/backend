import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, RolesGuard, PermissionGuard } from '../../common/guards';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { Role } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { W3DeliveryPolicyService } from './w3-delivery-policy-admin.service';
import {
  CreateW3DeliveryPolicyDraftDto,
  CreateW3DeliveryPolicyVersionDto,
  TransitionW3DeliveryPolicyDto,
  ActivateW3DeliveryPolicyDto,
  PreviewW3DeliveryPolicyVersionDto,
  PreviewW3DeliveryPolicyDto,
  ReviseW3DeliveryPolicyDraftDto,
  W3DeliveryPolicyHistoryDto,
  W3DeliveryPolicyInputGuard,
} from './w3-delivery-policy-admin.dto';

@ApiTags('Admin / W3 Delivery Policy Drafts')
@ApiBearerAuth()
@Controller('admin/w3-delivery-policy')
@UseGuards(
  JwtAuthGuard,
  RolesGuard,
  PermissionGuard,
  W3DeliveryPolicyInputGuard,
)
@Roles(Role.ADMIN)
export class W3DeliveryPolicyController {
  constructor(private readonly service: W3DeliveryPolicyService) {}

  @Get('versions/current')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:read')
  async versionCurrent(@CurrentUser() user: User) {
    return {
      data: await this.service.versionCurrent({ id: user.id, role: user.role }),
    };
  }

  @Get('versions/history')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:read')
  async versionsHistory(
    @Query() dto: W3DeliveryPolicyHistoryDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.versionsHistory(dto, {
        id: user.id,
        role: user.role,
      }),
    };
  }

  @Post('versions/drafts')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:update')
  async createVersion(
    @Body() dto: CreateW3DeliveryPolicyVersionDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.createVersion(dto, {
        id: user.id,
        role: user.role,
      }),
    };
  }

  @Patch('versions/drafts/:id')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:update')
  async reviseVersion(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReviseW3DeliveryPolicyDraftDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.reviseVersion(id, dto, {
        id: user.id,
        role: user.role,
      }),
    };
  }

  @Post('versions/:id/activate')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:update')
  async activate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ActivateW3DeliveryPolicyDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.activate(id, dto, {
        id: user.id,
        role: user.role,
      }),
    };
  }

  @Post('versions/:id/preview')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:update')
  async previewVersion(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PreviewW3DeliveryPolicyVersionDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.previewVersion(id, dto, {
        id: user.id,
        role: user.role,
      }),
    };
  }

  @Post('versions/:id/retire')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:update')
  async retire(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: TransitionW3DeliveryPolicyDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.retire(id, dto, {
        id: user.id,
        role: user.role,
      }),
    };
  }

  @Get('current')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:read')
  async current(@CurrentUser() user: User) {
    return {
      data: await this.service.current({ id: user.id, role: user.role }),
    };
  }

  @Get('history')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:read')
  async history(
    @Query() dto: W3DeliveryPolicyHistoryDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.history(dto, { id: user.id, role: user.role }),
    };
  }

  @Post('drafts')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:update')
  async create(
    @Body() dto: CreateW3DeliveryPolicyDraftDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.create(dto, { id: user.id, role: user.role }),
    };
  }

  @Patch('drafts/:id')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:update')
  async revise(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReviseW3DeliveryPolicyDraftDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.revise(id, dto, {
        id: user.id,
        role: user.role,
      }),
    };
  }

  @Post('preview')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermission('config:read')
  async preview(
    @Body() dto: PreviewW3DeliveryPolicyDto,
    @CurrentUser() user: User,
  ) {
    return {
      data: await this.service.preview(dto, { id: user.id, role: user.role }),
    };
  }
}
