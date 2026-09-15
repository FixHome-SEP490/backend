import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard, PermissionGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, RequirePermission, Roles } from '../../common/decorators';
import { PaginationMeta } from '../../shared/dto';
import { Role } from '../../shared/enums';
import {
  CreateSupportCaseDto,
  QuerySupportCasesDto,
  ResolveSupportCaseDto,
  SupportCaseDetailDto,
  SupportCaseSummaryDto,
} from './dto';
import { SupportCasesService, SupportCaseActor } from './support-cases.service';

@ApiTags('Support Cases')
@Controller('support/cases')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
@Roles(Role.SERVICE_MANAGER, Role.ADMIN)
@RequirePermission('support:read_all')
@ApiBearerAuth()
export class SupportCasesController {
  constructor(private readonly supportCasesService: SupportCasesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.CUSTOMER, Role.TECHNICIAN)
  @RequirePermission('order:read_related')
  @ApiOperation({
    summary: 'Customer/Technician: open a support escalation case',
  })
  @ApiCreatedResponse({
    description: 'Support case opened with OPEN status and current context',
    type: SupportCaseDetailDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid escalation body or mismatched booking/order context',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Customer/Technician role with owned context required',
  })
  @ApiNotFoundResponse({ description: 'Referenced booking or order not found' })
  async create(
    @Body() dto: CreateSupportCaseDto,
    @CurrentUser() actor: SupportCaseActor,
  ): Promise<SupportCaseDetailDto> {
    const created = await this.supportCasesService.openCaseForActor(dto, actor);
    return this.supportCasesService.findById(created.id);
  }

  @Get()
  @ApiOperation({
    summary: 'List support cases for Service Manager operations',
  })
  @ApiOkResponse({
    description: 'Support case summaries returned with pagination metadata',
    type: SupportCaseSummaryDto,
    isArray: true,
  })
  @ApiBadRequestResponse({
    description: 'Invalid support case filters or pagination',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Support case read permission required',
  })
  async findAll(
    @Query() query: QuerySupportCasesDto,
  ): Promise<{ data: SupportCaseSummaryDto[]; meta: PaginationMeta }> {
    const result = await this.supportCasesService.findAll(query);
    return {
      data: result.data,
      meta: {
        page: query.page,
        limit: query.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / query.limit),
      },
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a support case with read-only current context',
  })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Support case UUID' })
  @ApiOkResponse({
    description: 'Support case detail returned',
    type: SupportCaseDetailDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid support case UUID' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Support case read permission required',
  })
  @ApiNotFoundResponse({ description: 'Support case not found' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<SupportCaseDetailDto> {
    return this.supportCasesService.findById(id);
  }

  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.SERVICE_MANAGER)
  @RequirePermission('support:resolve')
  @ApiOperation({ summary: 'Resolve or reject a support case' })
  @ApiParam({ name: 'id', format: 'uuid', description: 'Support case UUID' })
  @ApiOkResponse({
    description: 'Support case finalized and returned with current context',
    type: SupportCaseDetailDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid finalization body or support case UUID',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'Service Manager role and resolve permission required',
  })
  @ApiNotFoundResponse({ description: 'Support case not found' })
  @ApiConflictResponse({ description: 'Support case is already terminal' })
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveSupportCaseDto,
    @CurrentUser() actor: SupportCaseActor,
  ): Promise<SupportCaseDetailDto> {
    return this.supportCasesService.resolveCase(id, dto, actor);
  }
}
