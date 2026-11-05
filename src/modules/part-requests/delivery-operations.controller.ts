import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  Equals,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../shared/enums';
import { RiskLimit } from '../../common/rate-limit/risk-rate-limit';
import { DeliveryOperationsService } from './delivery-operations.service';
import { EvidenceFile } from '../media/order-evidence-storage.service';

export class DeliveryCommandDto {
  @IsUUID('4') commandId: string;
  @IsInt() @Min(0) @Max(2147483646) expectedVersion: number;
}
export class ShippingProposalDto extends DeliveryCommandDto {
  @IsUUID('4') warehouseId: string;
  @IsUUID('4') evidenceId: string;
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/)
  courierReference: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) totalShippingFee: number;
}
export class ShippingConsentDto extends DeliveryCommandDto {
  @IsInt() @Min(1) @Max(2147483647) quoteVersion: number;
  @Matches(/^[a-f0-9]{64}$/) quoteFingerprint: string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) totalShippingFee: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) shippingShare: number;
  @Equals(true) accepted: true;
}
export class DeliveryActualDto extends DeliveryCommandDto {
  @IsInt() @Min(1) @Max(2147483647) quoteVersion: number;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) totalShippingFee: number;
  @IsUUID('4') evidenceId: string;
}
export class DeliveryStageDto extends DeliveryCommandDto {
  @IsUUID('4') evidenceId: string;
}
export class DeliveryUploadDto {
  @IsUUID('4') warehouseId: string;
  @IsIn([
    'QUOTE',
    'ACTUAL',
    'ISSUE_TO_COURIER',
    'COURIER_DISPATCH',
    'TECHNICIAN_RECEIPT',
  ])
  purpose: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) quoteVersion: number;
}
type AuthenticatedRequest = { user: { id: string; role: string } };

@Controller('part-requests/:id/delivery')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER, Role.TECHNICIAN, Role.SERVICE_MANAGER)
export class DeliveryOperationsController {
  constructor(private readonly service: DeliveryOperationsService) {}
  private actor(req: AuthenticatedRequest) {
    return { id: req.user.id, role: req.user.role };
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  async read(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return { data: await this.service.read(id, this.actor(req)) };
  }
  @Post('proposal')
  @RiskLimit('warehouse-stock')
  @Roles(Role.SERVICE_MANAGER)
  @Header('Cache-Control', 'no-store')
  async propose(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ShippingProposalDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.propose(id, { ...body }, this.actor(req)),
    };
  }
  @Post('consent')
  @RiskLimit('warehouse-stock')
  @Roles(Role.CUSTOMER, Role.TECHNICIAN)
  @Header('Cache-Control', 'no-store')
  async consent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ShippingConsentDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.consent(id, { ...body }, this.actor(req)),
    };
  }
  @Post('actual')
  @RiskLimit('warehouse-stock')
  @Roles(Role.SERVICE_MANAGER)
  @Header('Cache-Control', 'no-store')
  async actual(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryActualDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.actual(id, { ...body }, this.actor(req)),
    };
  }
  @Post('reserve')
  @RiskLimit('warehouse-stock')
  @Roles(Role.TECHNICIAN)
  @Header('Cache-Control', 'no-store')
  async reserve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryCommandDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.physical(
        id,
        'RESERVE',
        { ...body },
        this.actor(req),
      ),
    };
  }
  @Post('release')
  @RiskLimit('warehouse-stock')
  @Roles(Role.SERVICE_MANAGER)
  @Header('Cache-Control', 'no-store')
  async release(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryCommandDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.physical(
        id,
        'RELEASE',
        { ...body },
        this.actor(req),
      ),
    };
  }
  @Post('issue-to-courier')
  @RiskLimit('warehouse-stock')
  @Roles(Role.SERVICE_MANAGER)
  @Header('Cache-Control', 'no-store')
  async issue(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryStageDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.physical(
        id,
        'ISSUE_TO_COURIER',
        { ...body },
        this.actor(req),
      ),
    };
  }
  @Post('dispatch')
  @RiskLimit('warehouse-stock')
  @Roles(Role.SERVICE_MANAGER)
  @Header('Cache-Control', 'no-store')
  async dispatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryStageDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.physical(
        id,
        'COURIER_DISPATCH',
        { ...body },
        this.actor(req),
      ),
    };
  }
  @Post('receipt')
  @RiskLimit('warehouse-stock')
  @Roles(Role.TECHNICIAN)
  @Header('Cache-Control', 'no-store')
  async receipt(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryStageDto,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.physical(
        id,
        'TECHNICIAN_RECEIPT',
        { ...body },
        this.actor(req),
      ),
    };
  }
  @Post('evidence')
  @RiskLimit('media-upload')
  @Roles(Role.SERVICE_MANAGER, Role.TECHNICIAN)
  @Header('Cache-Control', 'no-store')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 3 },
    }),
  )
  async upload(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DeliveryUploadDto,
    @UploadedFile() file: EvidenceFile,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.upload(
        id,
        body.warehouseId,
        body.purpose,
        body.quoteVersion,
        file,
        this.actor(req),
      ),
    };
  }
  @Get('evidence/:evidenceId')
  @Header('Cache-Control', 'no-store')
  async evidence(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return {
      data: await this.service.evidenceAccess(id, evidenceId, this.actor(req)),
    };
  }
}
