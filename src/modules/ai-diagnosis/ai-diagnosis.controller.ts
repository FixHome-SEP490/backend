// src/modules/ai-diagnosis/ai-diagnosis.controller.ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AiDiagnosisService } from './ai-diagnosis.service';
import { AnalyzeDto, AskDto } from './dto/ai-contract.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AiDiagnosisBookingAuthGuard } from './ai-diagnosis-booking-auth.guard';

/**
 * The app's single door to the AI.
 *
 * Mobile never calls the GPU box directly: the box is rented per demo, so its
 * host and port change every time, and it has no authentication of its own.
 * Routing through here means a new rental is one line in this service's .env
 * instead of a new app build.
 *
 * Responses are passed through close to verbatim, with `serviceId` added, so
 * the AI stays the single author of what it claims. Handlers return the payload
 * bare: the global TransformInterceptor already wraps it as
 * {success, statusCode, message, data}, and wrapping it here too gave the client
 * a data.data to dig through.
 */
@ApiTags('AI Diagnosis')
@Controller()
export class AiDiagnosisController {
  constructor(private readonly aiDiagnosisService: AiDiagnosisService) {}

  @Post('ai/diagnoses')
  @UseGuards(AiDiagnosisBookingAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Diagnose from a description and up to three photos (advisory only)',
    description:
      'Send no sessionId on the first message, then echo back the sessionId from the reply so the assistant keeps the appliance and the symptoms. Images are data URIs or bare base64, at most three, JPEG/PNG/WebP up to 8 MiB each.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The AI reply, with serviceId resolved. status is ok, needs_clarification, or unavailable when the AI could not be reached.',
  })
  async analyze(@Body() dto: AnalyzeDto, @Req() req: { user?: { id: string; role: string } }) {
    return this.aiDiagnosisService.analyze(dto, req?.user);
  }

  @Post('ai/chat/ask')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Ask the assistant a question with no photo',
    description:
      'Use this for questions about prices, warranty, coverage and general appliance advice. answerVi always carries prose. status may be ok, out_of_scope, general_knowledge, no_grounding, or unavailable.',
  })
  async ask(@Body() dto: AskDto) {
    return this.aiDiagnosisService.ask(dto);
  }

  @Get('ai/chat/acknowledgements')
  @ApiOperation({
    summary: 'Short holding lines to show while the model is thinking',
  })
  async acknowledgements() {
    return this.aiDiagnosisService.getAcknowledgements();
  }

  @Get('ai/health')
  @ApiOperation({
    summary: 'Whether the AI Service is reachable and both models are attached',
    description:
      'A published port is not a working service: the box answers about three and a half minutes before the models finish loading.',
  })
  async health() {
    return this.aiDiagnosisService.checkAiServiceHealth();
  }

  @Get('ai/diagnoses/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Read a stored diagnosis',
    description:
      'Only diagnoses submitted with a bookingId are stored; a chat that never became a booking has nothing to read back.',
  })
  async getById(@Param('id') id: string, @Req() req: { user: { id: string; role: string } }) {
    return this.aiDiagnosisService.findById(id, req.user);
  }

  /**
   * Older path kept alive because it is already in use elsewhere. Same handler.
   */
  @Post('ai-diagnosis/analyze')
  @UseGuards(AiDiagnosisBookingAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deprecated alias for POST ai/diagnoses' })
  async analyzeLegacy(@Body() dto: AnalyzeDto, @Req() req: { user?: { id: string; role: string } }) {
    return this.aiDiagnosisService.analyze(dto, req?.user);
  }
}
