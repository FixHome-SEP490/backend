// src/modules/technician-skill-verifications/dto/submit-category-evidence.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { SubmitSkillEvidenceDto } from './submit-skill-evidence.dto';

// One paper for several service categories at once (e.g. an "điện lạnh" diploma covers Điều hòa and Tủ lạnh). The server
// attaches it to every skill the technician has in those categories, so the reviewer still sees it per skill.
export class SubmitCategoryEvidenceDto extends SubmitSkillEvidenceDto {
  @ApiProperty({ type: [String], format: 'uuid', description: 'Nhóm dịch vụ mà giấy tờ này áp dụng' })
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12) @ArrayUnique() @IsUUID('all', { each: true })
  categoryIds: string[];
}
