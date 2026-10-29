import {
  Body, Controller, Get, Header, HttpCode, HttpStatus, Param, ParseEnumPipe,
  ParseUUIDPipe, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission, Roles } from '../../common/decorators';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { CashPaymentIntent } from './entities/cash-payment-intent.entity';
import { CancelCashIntentDto, CashIntentScopeKind, CreateCashIntentDto, ReceiveCashIntentDto } from './dto/cash-intent.dto';
import { FinanceService } from './finance.service';

type CashRequest = { user: { id: string; role: string } };

@ApiTags('Cash intents')
@ApiBearerAuth()
@Controller('finance/cash-intents')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
export class CashIntentController {
  constructor(private readonly finance: FinanceService) {}

  private view(intent: CashPaymentIntent | null) {
    if (!intent) return null;
    return {
      id: intent.id,
      scopeKind: intent.scopeKind,
      scopeId: intent.scopeId,
      status: intent.status,
      grossVnd: intent.grossVnd,
      customerDueVnd: intent.customerDueVnd,
      technicianId: intent.technicianId,
      createdAt: intent.createdAt,
      receivedAt: intent.receivedAt,
      receiptId: intent.cashSettlementId ?? intent.visitGroupPaymentId ?? null,
    };
  }

  @Get(':scopeKind/:scopeId')
  @Header('Cache-Control', 'no-store')
  @Roles(Role.CUSTOMER, Role.TECHNICIAN, Role.SERVICE_MANAGER, Role.ADMIN)
  @RequirePermission('order:read_related')
  async get(@Param('scopeKind', new ParseEnumPipe(CashIntentScopeKind)) scopeKind: CashIntentScopeKind,
    @Param('scopeId', ParseUUIDPipe) scopeId: string, @Req() req: CashRequest) {
    const intent = await this.finance.getCashIntent(scopeKind, scopeId, req.user);
    return { data: this.view(intent), meta: { cashFirstEnabled: this.finance.isCashFirstEnabled() } };
  }

  @Post(':scopeKind/:scopeId')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Roles(Role.CUSTOMER)
  @RequirePermission('invoice:pay_own')
  async create(@Param('scopeKind', new ParseEnumPipe(CashIntentScopeKind)) scopeKind: CashIntentScopeKind,
    @Param('scopeId', ParseUUIDPipe) scopeId: string, @Body() body: CreateCashIntentDto, @Req() req: CashRequest) {
    return { data: this.view(await this.finance.createCashIntent(scopeKind, scopeId, body, req.user)) };
  }

  @Post(':scopeKind/:scopeId/received')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Roles(Role.TECHNICIAN)
  @RequirePermission('order:update_status')
  async receive(@Param('scopeKind', new ParseEnumPipe(CashIntentScopeKind)) scopeKind: CashIntentScopeKind,
    @Param('scopeId', ParseUUIDPipe) scopeId: string, @Body() body: ReceiveCashIntentDto, @Req() req: CashRequest) {
    return { data: this.view(await this.finance.receiveCashIntent(scopeKind, scopeId, body, req.user)) };
  }

  @Post(':scopeKind/:scopeId/cancel')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Roles(Role.CUSTOMER)
  @RequirePermission('invoice:pay_own')
  async cancel(@Param('scopeKind', new ParseEnumPipe(CashIntentScopeKind)) scopeKind: CashIntentScopeKind,
    @Param('scopeId', ParseUUIDPipe) scopeId: string, @Body() body: CancelCashIntentDto, @Req() req: CashRequest) {
    return { data: this.view(await this.finance.cancelCashIntent(scopeKind, scopeId, body, req.user)) };
  }
}
