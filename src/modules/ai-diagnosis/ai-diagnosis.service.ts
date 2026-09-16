// src/modules/ai-diagnosis/ai-diagnosis.service.ts
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, timeout } from 'rxjs';
import { AiDiagnosis } from './entities/ai-diagnosis.entity';
import { Service } from '../services/entities/service.entity';
import {
  DiagnosisRequestDto,
  DiagnosisResponseDto,
  DiagnosisFallbackResponseDto,
  UrgencyLevel,
} from './dto';

@Injectable()
export class AiDiagnosisService {
  private readonly logger = new Logger(AiDiagnosisService.name);
  private readonly aiServiceUrl: string;
  private readonly requestTimeoutMs = 15000;

  constructor(
    @InjectRepository(AiDiagnosis)
    private readonly diagnosisRepo: Repository<AiDiagnosis>,
    @InjectRepository(Service)
    private readonly serviceRepo: Repository<Service>,
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
        status: 'demo_ai_fallback',
        provider: 'fixhome-intelligent-advisor',
      };
    }
  }

  /**
   * Generate rich domain-specific mock response based on description keywords and link with real service catalog
   */
  private async generateIntelligentDemoDiagnosis(description: string, categoryHint?: string): Promise<any> {
    const text = (description || '').toLowerCase();
    const services = await this.serviceRepo.find({ where: { isActive: true } });

    // 1. Air conditioner (Điều hòa / máy lạnh)
    if (text.includes('điều hòa') || text.includes('máy lạnh') || text.includes('không mát') || text.includes('chảy nước')) {
      const matched = services.find(s => s.name.toLowerCase().includes('điều hòa') || s.name.toLowerCase().includes('máy lạnh'));
      return {
        possibleProblems: [
          'Thiếu gas làm lạnh R32/R410A hoặc hở rắc co kết nối',
          'Tắc nghẽn máng thoát nước dàn lạnh do rêu mốc lâu ngày',
          'Tụ đề máy nén (Capacitor) bị suy giảm trị số điện dung',
        ],
        possibleCauses: [
          'Máy không được bảo dưỡng định kỳ trong 6 tháng qua khiến bụi bẩn bám kín dàn tản nhiệt',
          'Đường ống đồng bị rung lắc gây hở mối loe hoặc đường thoát nước bị nghẽn',
        ],
        urgency: text.includes('chảy nước') ? UrgencyLevel.HIGH : UrgencyLevel.MEDIUM,
        estimatedCostMin: 180000,
        estimatedCostMax: 450000,
        suggestedServiceId: matched ? matched.id : null,
        suggestedServiceName: matched ? matched.name : 'Vệ sinh & nạp gas điều hòa',
        suggestedSkill: 'Điện lạnh dân dụng',
        troubleshooting: [
          'Tạm thời tắt máy và ngắt cầu dao nếu nước chảy tràn vào thiết bị điện tử bên dưới',
          'Kiểm tra và vệ sinh sơ bộ lưới lọc bụi ở mặt nạ dàn lạnh',
          'Đảm bảo remote đang ở chế độ Cool (hình bông tuyết) thay vì Fan Only hoặc Dry',
        ],
        confidence: 0.88,
        isFallback: true,
        disclaimer: 'Kết quả AI chỉ mang tính tham khảo. Kỹ thuật viên sẽ kiểm tra thực tế trước khi báo giá.',
      };
    }

    // 2. Electrical (Điện, chập, aptomat, mất điện)
    if (text.includes('điện') || text.includes('chập') || text.includes('aptomat') || text.includes('nhảy áp') || text.includes('ổ cắm')) {
      const matched = services.find(s => s.name.toLowerCase().includes('điện') || s.name.toLowerCase().includes('aptomat'));
      return {
        possibleProblems: [
          'Chập cháy tiếp điểm dây nguồn âm tường do quá tải dòng điện',
          'Aptomat quá dòng / chống giật bị lão hóa thanh lưỡng kim hoặc hỏng cơ cấu nhả',
          'Hở cách điện hoặc ẩm ướt rò rỉ điện ra vỏ kim loại thiết bị',
        ],
        possibleCauses: [
          'Sử dụng đồng thời nhiều thiết bị công suất cao vượt định mức chịu tải của dây dẫn',
          'Độ ẩm môi trường cao hoặc côn trùng làm hỏng lớp vỏ bọc cách điện',
        ],
        urgency: UrgencyLevel.HIGH,
        estimatedCostMin: 200000,
        estimatedCostMax: 550000,
        suggestedServiceId: matched ? matched.id : null,
        suggestedServiceName: matched ? matched.name : 'Sửa chập điện âm tường / nhảy Aptomat',
        suggestedSkill: 'Điện dân dụng & Điện âm tường',
        troubleshooting: [
          'Ngay lập tức ngắt cầu dao tổng của tầng hoặc toàn bộ nhà để phòng chống cháy nổ',
          'Rút phích cắm tất cả các thiết bị công suất lớn (bình nóng lạnh, lò vi sóng, bếp từ)',
          'Tuyệt đối không dùng tay trần chạm vào dây điện hoặc vùng tường bị ẩm ướt',
        ],
        confidence: 0.91,
        isFallback: true,
        disclaimer: 'Kết quả AI chỉ mang tính tham khảo. Kỹ thuật viên sẽ kiểm tra thực tế trước khi báo giá.',
      };
    }

    // 3. Plumbing (Nước, rò rỉ, vỡ ống, nghẹt)
    if (text.includes('nước') || text.includes('rò rỉ') || text.includes('vòi') || text.includes('tắc') || text.includes('bồn cầu')) {
      const matched = services.find(s => s.name.toLowerCase().includes('nước') || s.name.toLowerCase().includes('vòi'));
      return {
        possibleProblems: [
          'Nứt gãy hoặc hở mối hàn nhiệt ống PPR chịu áp lực',
          'Lão hóa gioăng cao su van một chiều hoặc hỏng lõi gốm vòi gạt',
          'Tắc nghẽn cặn lắng canxi trong đường ống dẫn hoặc bẫy mùi siphon',
        ],
        possibleCauses: [
          'Áp lực nước từ máy bơm tăng áp quá lớn gây nứt vỡ phụ kiện ren',
          'Hiện tượng búa nước (rung giật đường ống) lâu ngày làm hở mối dán keo/hàn',
        ],
        urgency: text.includes('vỡ') || text.includes('ngập') ? UrgencyLevel.HIGH : UrgencyLevel.MEDIUM,
        estimatedCostMin: 150000,
        estimatedCostMax: 400000,
        suggestedServiceId: matched ? matched.id : null,
        suggestedServiceName: matched ? matched.name : 'Sửa rò rỉ đường ống nước / bục vỡ',
        suggestedSkill: 'Cấp thoát nước & Thiết bị vệ sinh',
        troubleshooting: [
          'Khóa ngay van nước tổng trước đồng hồ hoặc van khóa nhánh khu vực vệ sinh',
          'Dùng khăn hoặc xô hứng nước tạm thời để tránh thấm dột sàn nhà',
          'Không tự ý đục tường nếu chưa xác định chính xác vị trí bục vỡ',
        ],
        confidence: 0.89,
        isFallback: true,
        disclaimer: 'Kết quả AI chỉ mang tính tham khảo. Kỹ thuật viên sẽ kiểm tra thực tế trước khi báo giá.',
      };
    }

    // 4. Default / Other general repair
    const defaultService = services[0] || null;
    return {
      possibleProblems: [
        'Sự cố hao mòn cơ điện thiết bị gia đình cần kiểm tra trực tiếp',
        'Tiếp điểm lỏng hoặc biến dạng linh kiện cơ khí sau thời gian dài sử dụng',
      ],
      possibleCauses: [
        'Tuổi thọ thiết bị lâu năm hoặc môi trường hoạt động nhiều bụi bẩn và độ ẩm',
      ],
      urgency: UrgencyLevel.MEDIUM,
      estimatedCostMin: 150000,
      estimatedCostMax: 500000,
      suggestedServiceId: defaultService ? defaultService.id : null,
      suggestedServiceName: defaultService ? defaultService.name : (categoryHint || 'Kiểm tra/chẩn đoán thiết bị tại nhà'),
      suggestedSkill: 'Bảo trì gia đình',
      troubleshooting: [
        'Rút nguồn điện thiết bị khi không sử dụng',
        'Ghi lại các âm thanh lạ hoặc biểu hiện bất thường để cung cấp cho thợ',
      ],
      confidence: 0.85,
      isFallback: true,
      disclaimer: 'Kết quả AI chỉ mang tính tham khảo. Kỹ thuật viên sẽ kiểm tra thực tế trước khi báo giá.',
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
      resultData = await this.generateIntelligentDemoDiagnosis(dto.description, dto.categoryHint);
    }

    const latencyMs = Date.now() - startTime;

    // Standardize to Section 7 format
    const problems = resultData.possibleProblems || (resultData.possibleIssues?.map((i: any) => typeof i === 'string' ? i : i.name) || []);
    const causes = resultData.possibleCauses ? resultData.possibleCauses.map((c: any) => typeof c === 'string' ? c : c.description) : [];
    const troubleshooting = resultData.troubleshooting || resultData.suggestedActions || [];
    const costMin = resultData.estimatedCostMin || resultData.estimatedCost?.min || 150000;
    const costMax = resultData.estimatedCostMax || resultData.estimatedCost?.max || 500000;

    // Persist diagnosis record for audit and historical review
    try {
      const record = this.diagnosisRepo.create({
        bookingId: dto.bookingId || '00000000-0000-0000-0000-000000000000',
        provider: providerName,
        model: providerName === 'trained_model' ? 'fixhome-vision-text-v1' : 'fixhome-demo-advisor-v1',
        possibleIssues: problems.map((name: string) => ({ name, probability: 0.85 })),
        possibleCauses: causes.map((desc: string) => ({ description: desc, severity: 'MEDIUM' })),
        urgency: String(resultData.urgency || 'MEDIUM'),
        priceRangeMin: costMin,
        priceRangeMax: costMax,
        suggestedServiceId: resultData.suggestedServiceId || null,
        confidence: resultData.confidence || 0.88,
        latencyMs,
        rawResponse: resultData,
      });

      const saved = await this.diagnosisRepo.save(record);
      return {
        id: saved.id,
        possibleProblems: problems,
        possibleCauses: causes,
        urgency: resultData.urgency || UrgencyLevel.MEDIUM,
        estimatedCostMin: costMin,
        estimatedCostMax: costMax,
        suggestedServiceId: resultData.suggestedServiceId || null,
        suggestedServiceName: resultData.suggestedServiceName || null,
        suggestedSkill: resultData.suggestedSkill || null,
        troubleshooting,
        confidence: resultData.confidence || 0.88,
        isFallback: providerName === 'demo_ai_fallback',
        disclaimer: 'Kết quả AI chỉ mang tính tham khảo. Kỹ thuật viên sẽ kiểm tra thực tế trước khi báo giá.',
        // Backward compatibility
        possibleIssues: problems.map((name: string, i: number) => ({ name, probability: 0.9 - i * 0.1 })),
        estimatedCost: { min: costMin, max: costMax, currency: 'VND' },
        suggestedActions: troubleshooting,
      };
    } catch (dbErr) {
      this.logger.warn(`Failed to persist diagnosis record: ${dbErr.message}`);
      return {
        ...resultData,
        possibleProblems: problems,
        possibleCauses: causes,
        troubleshooting,
        isFallback: providerName === 'demo_ai_fallback',
        disclaimer: 'Kết quả AI chỉ mang tính tham khảo. Kỹ thuật viên sẽ kiểm tra thực tế trước khi báo giá.',
      };
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
