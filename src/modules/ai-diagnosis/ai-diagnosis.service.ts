// src/modules/ai-diagnosis/ai-diagnosis.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout } from 'rxjs';
import { AiDiagnosis } from './entities/ai-diagnosis.entity';
import { Service } from '../services/entities/service.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { BookingInvitation } from '../bookings/entities/booking-invitation.entity';
import { ServiceOrder } from '../service-orders/entities/service-order.entity';
import { TechnicianAssignment } from '../service-orders/entities/technician-assignment.entity';
import { BookingStatus, InvitationStatus, Role, ServiceOrderStatus } from '../../shared/enums';
import {
  AnalyzeDto,
  AskDto,
  AiRecommendedService,
  AI_MAX_IMAGES,
} from './dto/ai-contract.dto';

/**
 * Proxy in front of the AI Service.
 *
 * Three jobs, and deliberately nothing else. It forwards the request, resolves
 * the AI's catalogue codes into service ids the app can book, and tells the
 * truth when the AI is not there.
 *
 * It does not invent diagnoses. An earlier version of this file did: when the
 * AI was unreachable it produced named faults and price ranges of its own
 * ("thieu gas R32", 180k-450k) and returned them through the same field as a
 * real answer, flagged only by an `isFallback` boolean that the mobile client
 * never read. Since the GPU box is rented per demo, unreachable was the normal
 * case, so most of what anyone saw was written by that function. It is gone.
 * The business rule it was trying to honour - AI failure must never block a
 * booking - is honoured instead by answering that the assistant is unavailable
 * while leaving every booking route open.
 */
@Injectable()
export class AiDiagnosisService {
  private readonly logger = new Logger(AiDiagnosisService.name);
  private readonly aiServiceUrl: string;

  /**
   * The model's own ceiling is eight seconds; the rest is network to a rented
   * box that may be on another continent. Measured round trips are 0.3 to 2.4
   * seconds, so thirty is slack, not an expectation.
   */
  private readonly requestTimeoutMs = 30000;

  /** code -> service id. The catalogue changes about never; a restart clears it. */
  private serviceIdByCode = new Map<string, string>();
  private serviceCacheLoadedAt = 0;
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;

  private acknowledgements: Record<string, unknown> | null = null;
  private acknowledgementsLoadedAt = 0;

  constructor(
    @InjectRepository(AiDiagnosis)
    private readonly diagnosisRepo: Repository<AiDiagnosis>,
    @InjectRepository(Service)
    private readonly serviceRepo: Repository<Service>,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    const configured =
      this.configService.get<string>('AI_SERVICE_URL') || 'http://localhost:8000';
    this.aiServiceUrl = configured.replace(/\/+$/, '');
  }

  // ---------------------------------------------------------------- health

  async checkAiServiceHealth(): Promise<{
    status: string;
    available: boolean;
    detail?: Record<string, unknown>;
  }> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.aiServiceUrl}/health`).pipe(timeout(5000)),
      );
      const body = response.data || {};
      const vlm = body.vlm?.attached === true;
      const detector = body.detector?.attached === true;
      return {
        status: vlm && detector ? 'connected' : 'loading',
        available: vlm && detector,
        detail: {
          vlmAttached: vlm,
          detectorAttached: detector,
          knowledgeChunks: body.knowledge?.chunks ?? null,
        },
      };
    } catch (error) {
      this.logger.warn(`AI Service health check failed: ${this.reason(error)}`);
      return { status: 'unavailable', available: false };
    }
  }

  // --------------------------------------------------------------- analyze

  /**
   * Photo and/or description in, structured advice out.
   *
   * Business rule: AI failure never blocks the booking flow, so this resolves
   * rather than throwing and the caller can always carry on.
   */
  async analyze(dto: AnalyzeDto, actor?: { id: string; role: string }): Promise<Record<string, unknown>> {
    if (dto.bookingId !== undefined) {
      if (typeof dto.bookingId !== 'string' || !dto.bookingId.trim()) {
        throw new NotFoundException('Booking not found');
      }
      if (!actor?.id || actor.role !== Role.CUSTOMER ||
          !await this.diagnosisRepo.manager.findOneBy(Booking, {
            id: dto.bookingId, customerId: actor.id,
          })) {
        throw new NotFoundException('Booking not found');
      }
    }
    const startedAt = Date.now();
    const images = (dto.images || []).slice(0, AI_MAX_IMAGES);

    let payload: Record<string, unknown>;
    try {
      const response = await firstValueFrom(
        this.httpService
          .post<Record<string, unknown>>(
            `${this.aiServiceUrl}/api/v1/diagnosis/analyze`,
            {
              description: dto.description ?? '',
              images,
              sessionId: dto.sessionId,
              categoryHint: dto.categoryHint,
            },
          )
          .pipe(timeout(this.requestTimeoutMs)),
      );
      payload = response.data || {};
    } catch (error) {
      this.logger.warn(`AI analyze unavailable: ${this.reason(error)}`);
      return this.unavailable(dto.sessionId);
    }

    const latencyMs = Date.now() - startedAt;
    const enriched = await this.attachServiceIds(payload);
    await this.persistIfBooked(dto, enriched, latencyMs);
    return { ...enriched, aiAvailable: true, latencyMs };
  }

  // ------------------------------------------------------------------- ask

  /** A question with no photo. Answers are prose; `answerVi` is always filled. */
  async ask(dto: AskDto): Promise<Record<string, unknown>> {
    try {
      const response = await firstValueFrom(
        this.httpService
          .post<Record<string, unknown>>(`${this.aiServiceUrl}/api/v1/chat/ask`, {
            question: dto.question,
            sessionId: dto.sessionId,
            deviceType: dto.deviceType,
          })
          .pipe(timeout(this.requestTimeoutMs)),
      );
      const enriched = await this.attachServiceIds(response.data || {});
      return { ...enriched, aiAvailable: true };
    } catch (error) {
      this.logger.warn(`AI ask unavailable: ${this.reason(error)}`);
      return this.unavailable(dto.sessionId);
    }
  }

  // ------------------------------------------------------- acknowledgements

  /**
   * The "I am reading it" lines the client shows while the model thinks.
   *
   * The AI ships them grouped by situation - first photo, first text, follow up,
   * price question, before asking back, long wait - so the wait can sound like
   * it belongs to the message that caused it. Passed through untouched; the
   * client chooses the group. Cached, and backed by a local copy, because a
   * spinner with no words is a worse failure than a slightly stale sentence.
   */
  async getAcknowledgements(): Promise<Record<string, unknown>> {
    const fresh =
      Date.now() - this.acknowledgementsLoadedAt < AiDiagnosisService.CACHE_TTL_MS;
    if (this.acknowledgements && fresh) {
      return this.acknowledgements;
    }

    try {
      const response = await firstValueFrom(
        this.httpService
          .get<Record<string, unknown>>(
            `${this.aiServiceUrl}/api/v1/chat/acknowledgements`,
          )
          .pipe(timeout(5000)),
      );
      const body = response.data || {};
      if (body.situations && typeof body.situations === 'object') {
        this.acknowledgements = body;
        this.acknowledgementsLoadedAt = Date.now();
        return body;
      }
    } catch (error) {
      this.logger.warn(`AI acknowledgements unavailable: ${this.reason(error)}`);
    }

    return (
      this.acknowledgements ?? {
        version: 'local-fallback',
        situations: {
          first_text: ['Dạ em nhận được thông tin rồi ạ, anh chị chờ em xem qua một chút nhé.'],
          first_photo: ['Dạ em nhận được ảnh rồi ạ, anh chị chờ em xem qua một chút nhé.'],
          follow_up: ['Dạ vâng, em ghi nhận thêm ạ. Để em xem lại nha.'],
          price_question: ['Dạ vâng, để em tra bảng giá cho anh chị ngay ạ.'],
          general_question: ['Dạ vâng, câu này để em xem lại rồi trả lời anh chị cho kỹ ạ.'],
        },
      }
    );
  }

  // -------------------------------------------------------------- retrieval

  async findById(id: string, actor: { id: string; role: string }): Promise<AiDiagnosis> {
    // A diagnosis may contain unredacted text/images. JWT alone is not authorization.
    return this.diagnosisRepo.manager.transaction(async manager => {
      const denied = () => new NotFoundException('Diagnosis not found');
      const diagnosis = await manager.findOneBy(AiDiagnosis, { id });
      if (!diagnosis) throw denied();
      const booking = await manager.findOne(Booking, {
        where: { id: diagnosis.bookingId }, lock: { mode: 'pessimistic_write' },
      });
      if (!booking) throw denied();
      if (actor.role === Role.ADMIN || actor.role === Role.SERVICE_MANAGER) return diagnosis;
      if (actor.role === Role.CUSTOMER && booking.customerId === actor.id) return diagnosis;
      if (actor.role !== Role.TECHNICIAN || booking.status !== BookingStatus.MATCHED) throw denied();

      const order = await manager.findOne(ServiceOrder, {
        where: { bookingId: booking.id }, lock: { mode: 'pessimistic_write' },
      });
      if (!order || order.status === ServiceOrderStatus.CANCELLED ||
          !await manager.findOneBy(TechnicianAssignment, {
            serviceOrderId: order.id, technicianId: actor.id, isActive: true,
          }) || !await manager.findOneBy(BookingInvitation, {
            bookingId: booking.id, technicianId: actor.id, status: InvitationStatus.ACCEPTED,
          })) throw denied();
      return diagnosis;
    });
  }

  // ---------------------------------------------------------------- private

  /**
   * The AI names services by catalogue code; a booking needs the row id. Both
   * catalogues were seeded from the same list, so all twenty-one codes the AI
   * can return do resolve - but an unknown code yields null rather than
   * throwing, because a missing id should cost the customer one button, not the
   * whole answer.
   */
  private async attachServiceIds(
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const services = payload.recommendedServices as
      | AiRecommendedService[]
      | undefined;
    if (!Array.isArray(services) || services.length === 0) {
      return payload;
    }

    const byCode = await this.loadServiceCodes();
    return {
      ...payload,
      recommendedServices: services.map((service) => ({
        ...service,
        serviceId: byCode.get(service.serviceCode) ?? null,
      })),
    };
  }

  private async loadServiceCodes(): Promise<Map<string, string>> {
    const fresh =
      Date.now() - this.serviceCacheLoadedAt < AiDiagnosisService.CACHE_TTL_MS;
    if (this.serviceIdByCode.size > 0 && fresh) {
      return this.serviceIdByCode;
    }

    try {
      const rows = await this.serviceRepo.find({
        where: { isActive: true },
        select: ['id', 'code'],
      });
      const map = new Map<string, string>();
      for (const row of rows) {
        if (row.code) {
          map.set(row.code, row.id);
        }
      }
      if (map.size > 0) {
        this.serviceIdByCode = map;
        this.serviceCacheLoadedAt = Date.now();
      }
    } catch (error) {
      this.logger.warn(`Could not load the service catalogue: ${this.reason(error)}`);
    }

    return this.serviceIdByCode;
  }

  /**
   * Kept only when a booking exists to hang it on.
   *
   * The column is `booking_id uuid NOT NULL`, and the previous version filled it
   * with an all-zero uuid on every single call, so the table accumulated rows
   * belonging to no booking and referring to nothing. A diagnosis is worth
   * keeping because it briefs the technician; with no booking there is no
   * technician, and the chat itself is explicitly not persisted.
   */
  private async persistIfBooked(
    dto: AnalyzeDto,
    payload: Record<string, unknown>,
    latencyMs: number,
  ): Promise<void> {
    if (!dto.bookingId) {
      return;
    }

    try {
      const faults = (payload.suspectedFaults || []) as {
        faultCode?: string;
        nameVi?: string;
        confidence?: number;
      }[];
      const services = (payload.recommendedServices || []) as AiRecommendedService[];
      const price = (payload.priceEstimate || {}) as {
        min?: number;
        max?: number | null;
      };
      const device = payload.device as { deviceType?: string } | null;
      const modelInfo = (payload.modelInfo || {}) as Record<string, unknown>;

      await this.diagnosisRepo.save(
        this.diagnosisRepo.create({
          bookingId: dto.bookingId,
          provider: 'ai_service',
          model: String(modelInfo.vlm ?? 'unknown'),
          possibleIssues: faults.map((fault) => ({
            code: fault.faultCode,
            name: fault.nameVi,
            probability: fault.confidence,
          })),
          possibleCauses: ((payload.suggestedActionsVi || []) as string[]).map(
            (action) => ({ description: action }),
          ),
          urgency: String(payload.urgency ?? 'MEDIUM'),
          priceRangeMin: Number(price.min ?? 0),
          priceRangeMax: Number(price.max ?? 0),
          suggestedServiceId: services[0]?.serviceId ?? null,
          confidence: Number(payload.confidence ?? 0),
          latencyMs,
          rawResponse: {
            deviceType: device?.deviceType ?? null,
            sessionId: payload.sessionId ?? null,
            faultCodes: faults.map((fault) => fault.faultCode),
            serviceCodes: services.map((service) => service.serviceCode),
          },
        }),
      );
    } catch (error) {
      // Losing the audit row must not lose the customer's answer.
      this.logger.warn(`Could not persist the diagnosis: ${this.reason(error)}`);
    }
  }

  /**
   * What we say when the AI is not answering. No faults, no prices, no
   * confidence score - nothing that could be mistaken for a diagnosis. The
   * client shows `messageVi` and keeps every booking path open.
   */
  private unavailable(sessionId?: string): Record<string, unknown> {
    return {
      sessionId: sessionId ?? null,
      status: 'unavailable',
      aiAvailable: false,
      device: null,
      suspectedFaults: [],
      recommendedServices: [],
      suggestedActionsVi: [],
      priceEstimate: null,
      urgency: 'LOW',
      confidence: 0,
      isLowConfidence: true,
      clarification: null,
      messageVi:
        'Trợ lý AI đang tạm thời không kết nối được, nên em chưa chẩn đoán giúp ' +
        'anh/chị lúc này ạ. Anh/chị vẫn đặt thợ bình thường được, thợ FixHome sẽ ' +
        'kiểm tra trực tiếp và báo giá trước khi sửa.',
      answerVi:
        'Trợ lý AI đang tạm thời không kết nối được ạ. Anh/chị vẫn đặt thợ bình ' +
        'thường được, thợ FixHome sẽ kiểm tra trực tiếp và báo giá trước khi sửa.',
      citations: [],
      disclaimerVi:
        'Đây là gợi ý sơ bộ, kết luận cuối cùng thuộc về kỹ thuật viên kiểm tra trực tiếp.',
    };
  }

  private reason(error: unknown): string {
    if (error && typeof error === 'object' && 'message' in error) {
      return String((error as { message: unknown }).message);
    }
    return String(error);
  }
}
