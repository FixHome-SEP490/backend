// src/modules/technician-skill-verifications/dto/reuse-skill-evidence.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';

// Papers the technician already sent (ids from GET technicians/me/skill-evidence), put on one more skill without uploading again.
export class ReuseSkillEvidenceDto {
  @ApiProperty({ type: [String], format: 'uuid', description: 'Giấy tờ đã nộp muốn dùng thêm cho kỹ năng này' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(20) @ArrayUnique() @IsUUID('all', { each: true })
  documentIds: string[];
}
