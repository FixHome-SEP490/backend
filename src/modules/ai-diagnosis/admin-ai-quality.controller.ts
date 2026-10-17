// src/modules/ai-diagnosis/admin-ai-quality.controller.ts
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Role } from '../../shared/enums';
import { AiDiagnosisService } from './ai-diagnosis.service';
import { AiQualityQueryDto } from './dto/ai-contract.dto';

/** How the assistant is doing, read by an admin; nothing here changes anything. */
@ApiTags('Admin / AI quality')
@Controller('admin/ai-quality')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@ApiBearerAuth()
export class AdminAiQualityController {
  constructor(private readonly service: AiDiagnosisService) {}

  @Get()
  @ApiOperation({
    summary: 'Admin: chất lượng trợ lý AI',
    description:
      'Số cuộc trò chuyện, số lượt, số cuộc khách báo trả lời sai/đúng, số đơn đặt từ trợ lý và tỉ lệ, theo ngày; 20 câu trả lời bị báo sai gần nhất kèm lời khách.',
  })
  quality(@Query() query: AiQualityQueryDto) {
    return this.service.quality(query.days ?? 7);
  }
}
