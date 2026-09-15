// src/modules/ai-diagnosis/ai-diagnosis.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout } from 'rxjs';
import { AiDiagnosis } from './entities/ai-diagnosis.entity';
import {
  DiagnosisRequestDto,
  DiagnosisResponseDto,
  DiagnosisFallbackResponseDto,
} from './dto';

@Injectable()
export class AiDiagnosisService {
  private readonly logger = new Logger(AiDiagnosisService.name);
  private readonly aiServiceUrl: string;
  private readonly requestTimeoutMs = 15000;

  constructor(
    @InjectRepository(AiDiagnosis)
    private readonly diagnosisRepo: Repository<AiDiagnosis>,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.aiServiceUrl = this.configService.get<string>(
      'AI_SERVICE_URL',
      'http://localhost:8000',
    );
  }

  /**
   * Health check call to AI Service
   */
  async checkAiServiceHealth(): Promise<{ status: string; provider?: string }> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.aiServiceUrl}/health`).pipe(
          timeout(3000),
        ),
      );
      return {
        status: response.data?.status === 'ok' ? 'connected' : 'degraded',
        provider: response.data?.provider || 'trained_model',
      };
    } catch {
      return {
        status: 'mock_stub',
        provider: 'fixhome-intelligent-advisor',
      };
    }
  }

  /**
   * Generate rich domain-specific mock response based on description keywords
   */
  private generateIntelligentDemoDiagnosis(description: string, categoryHint?: string): any {
    const text = (description || '').toLowerCase();

    // 1. Air conditioner (Điều hòa / máy lạnh)
    if (text.includes('điều hòa') || text.includes('máy lạnh') || text.includes('không mát') || text.includes('chảy nước')) {
      return {
        possibleIssues: [
          { name: 'Thiếu gas làm lạnh R32/R410A hoặc rò rỉ zắc co', probability: 0.88 },
          { name: 'Tắc nghẽn máng thoát nước / bẩn lá nhôm tản nhiệt', probability: 0.76 },
          { name: 'Tụ đề máy nén (Capacitor) yếu hoặc hỏng quạt gió', probability: 0.45 },
        ],
        possibleCauses: [
          { description: 'Máy không được bảo dưỡng định kỳ trong 6 tháng qua khiến bụi bẩn bám kín dàn tản nhiệt', severity: 'MEDIUM' },
          { description: 'Đường ống đồng bị rung lắc gây hở mối loe hoặc đường thoát nước bị rêu mốc tắc nghẽn', severity: 'HIGH' },
        ],
        urgency: text.includes('chảy nước') ? 'HIGH' : 'NORMAL',
        estimatedCostMin: 180000,
        estimatedCostMax: 450000,
        suggestedService: 'Vệ sinh máy lạnh & Bơm gas bổ sung',
        confidence: 0.92,
        disclaimer: 'Chẩn đoán demo từ FixHome AI Advisor. Kỹ thuật viên sẽ kiểm tra áp suất đồng hồ trực tiếp để báo giá chuẩn xác.',
      };
    }

    // 2. Electrical (Điện, chập, aptomat, mất điện)
    if (text.includes('điện') || text.includes('chập') || text.includes('aptomat') || text.includes('nhảy áp') || text.includes('ổ cắm')) {
      return {
        possibleIssues: [
          { name: 'Chập cháy tiếp điểm dây nguồn âm tường do quá tải', probability: 0.91 },
          { name: 'Aptomat quá dòng / chống giật bị lão hóa cơ cấu nhả', probability: 0.82 },
          { name: 'Hở cách điện hoặc ẩm ướt rò điện ra vỏ thiết bị', probability: 0.65 },
        ],
        possibleCauses: [
          { description: 'Sử dụng đồng thời nhiều thiết bị công suất cao vượt định mức dây dẫn', severity: 'HIGH' },
          { description: 'Độ ẩm môi trường hoặc chuột cắn làm hở vỏ bọc bảo vệ', severity: 'EMERGENCY' },
        ],
        urgency: 'EMERGENCY',
        estimatedCostMin: 200000,
        estimatedCostMax: 550000,
        suggestedService: 'Sửa chập điện âm tường & Thay thế Aptomat',
        confidence: 0.95,
        disclaimer: 'Cảnh báo nguy cơ giật điện: Vui lòng ngắt cầu dao tổng trước khi thợ tới hiện trường.',
      };
    }

    // 3. Plumbing (Nước, rò rỉ, vỡ ống, nghẹt)
    if (text.includes('nước') || text.includes('rò rỉ') || text.includes('vòi') || text.includes('tắc') || text.includes('bồn cầu')) {
      return {
        possibleIssues: [
          { name: 'Nứt gãy hoặc hở mối hàn ống nhiệt PPR chịu áp', probability: 0.86 },
          { name: 'Hỏng gioăng cao su van một chiều hoặc lõi vòi gạt', probability: 0.79 },
          { name: 'Tắc nghẽn cặn lắng canxi trong đường ống cấp', probability: 0.55 },
        ],
        possibleCauses: [
          { description: 'Áp lực nước từ máy bơm tăng áp quá lớn gây biến dạng phụ kiện ren', severity: 'MEDIUM' },
          { description: 'Hiện tượng rung giật đường ống âm tường lâu ngày gây hở mối nối', severity: 'HIGH' },
        ],
        urgency: text.includes('vỡ') ? 'EMERGENCY' : 'NORMAL',
        estimatedCostMin: 150000,
        estimatedCostMax: 400000,
        suggestedService: 'Dò tìm rò rỉ nước ngầm & Thay phụ kiện sen vòi',
        confidence: 0.89,
        disclaimer: 'Kết quả tham khảo từ FixHome AI. Thợ sẽ dùng máy đo áp suất chuyên dụng để xác định vị trí rò rỉ.',
      };
    }

    // 4. Default / Other general repair
    return {
      possibleIssues: [
        { name: 'Sự cố thiết bị gia đình cần tháo lắp kiểm tra cơ điện', probability: 0.85 },
        { name: 'Hỏng hóc linh kiện hao mòn tự nhiên theo thời gian vận hành', probability: 0.68 },
      ],
      possibleCauses: [
        { description: 'Tuổi thọ thiết bị lâu năm hoặc tiếp xúc nguồn điện chập chờn', severity: 'MEDIUM' },
      ],
      urgency: 'NORMAL',
      estimatedCostMin: 150000,
      estimatedCostMax: 500000,
      suggestedService: categoryHint || 'Sửa chữa điện máy gia dụng tại nhà',
      confidence: 0.86,
      disclaimer: 'Kết quả mang tính chất tư vấn sơ bộ. Kỹ thuật viên sẽ kiểm tra trực tiếp tại nhà để báo giá chuẩn xác.',
    };
  }

  /**
   * Analyze home repair issue with trained AI provider or intelligent demo fallback with DB persistence.
   * Business rule: AI failure never blocks the customer from completing a booking.
   */
  async analyzeIssue(
    dto: DiagnosisRequestDto & { bookingId?: string; images?: string[] },
    _userId?: string,
  ): Promise<DiagnosisResponseDto | DiagnosisFallbackResponseDto | any> {
    const startTime = Date.now();
    let resultData: any;
    let providerName = 'trained_model';

    try {
      const response = await firstValueFrom(
        this.httpService
          .post<DiagnosisResponseDto>(`${this.aiServiceUrl}/api/v1/diagnosis/analyze`, {
            description: dto.description,
            imageUrl: dto.imageUrl || (dto.images && dto.images[0]),
            categoryHint: dto.categoryHint,
          })
          .pipe(timeout(this.requestTimeoutMs)),
      );

      resultData = response.data;
    } catch (error) {
      providerName = 'demo_ai_fallback';
      this.logger.log(`AI external endpoint not reachable (${error.message}). Using intelligent demo advisor.`);
      resultData = this.generateIntelligentDemoDiagnosis(dto.description, dto.categoryHint);
    }

    const latencyMs = Date.now() - startTime;

    // Persist diagnosis record for audit and future model training data collection
    try {
      const record = this.diagnosisRepo.create({
        bookingId: dto.bookingId || '00000000-0000-0000-0000-000000000000',
        provider: providerName,
        model: providerName === 'trained_model' ? 'fixhome-vision-text-v1' : 'fixhome-demo-advisor-v1',
        possibleIssues: resultData.possibleIssues,
        possibleCauses: resultData.possibleCauses,
        urgency: resultData.urgency,
        priceRangeMin: resultData.estimatedCostMin || 150000,
        priceRangeMax: resultData.estimatedCostMax || 500000,
        confidence: resultData.confidence || 0.88,
        latencyMs,
        rawResponse: resultData,
      });

      const saved = await this.diagnosisRepo.save(record);
      return {
        ...resultData,
        id: saved.id,
      };
    } catch (dbErr) {
      this.logger.warn(`Failed to persist diagnosis record: ${dbErr.message}`);
      return resultData;
    }
  }

  async findById(id: string): Promise<AiDiagnosis> {
    const diagnosis = await this.diagnosisRepo.findOneBy({ id });
    if (!diagnosis) {
      throw new NotFoundException(`Diagnosis with id ${id} not found`);
    }
    return diagnosis;
  }
}
