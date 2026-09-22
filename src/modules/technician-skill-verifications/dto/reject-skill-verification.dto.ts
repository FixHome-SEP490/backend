// src/modules/technician-skill-verifications/dto/reject-skill-verification.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';
import { Trim } from '../../../shared/validation/input.transforms';

export class RejectSkillVerificationDto {
  @ApiProperty({
    example: 'Chưa đủ kinh nghiệm thực tế qua bài test tại chỗ, hẹn đánh giá lại sau 3 tháng.',
    description: 'Lý do từ chối yêu cầu duyệt kỹ năng',
  })
  @IsString()
  @Trim()
  @MaxLength(2000)
  @MinLength(5, { message: 'rejectionReason must be at least 5 characters long' })
  rejectionReason: string;
}
