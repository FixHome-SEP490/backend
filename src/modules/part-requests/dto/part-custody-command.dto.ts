import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';
import { PartCustodyCommandKind } from '../part-custody.types';

const MAX_PART_QUANTITY = 100;
const MAX_CUSTODY_VERSION = Number.MAX_SAFE_INTEGER;

function sanitizeReason(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const printableText = Array.from(value.normalize('NFKC'), (character) => {
    const codePoint = character.codePointAt(0) || 0;
    const isControl = codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
    const isFormatting = (codePoint >= 0x200b && codePoint <= 0x200f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) || codePoint === 0x2060 || codePoint === 0xfeff;
    return isControl || isFormatting ? ' ' : character;
  }).join('');

  return printableText
    .replace(/<[^>]*>/g, ' ')
    .replace(/\bhttps?:\/\/[^\s]+/gi, '[đã ẩn]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Z]{2,}/gi, '[đã ẩn]')
    .replace(/(?<!\d)(?:\+?84|0)(?:[\s().-]*\d){8,10}(?!\d)/g, '[đã ẩn]')
    .replace(/\s+/g, ' ')
    .trim();
}

@ValidatorConstraint({ name: 'custodyCommandFields' })
class CustodyCommandFields implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const dto = args.object as PartCustodyCommandDto;
    const allowed = dto.kind === 'record_usage' ? ['usedQty']
      : dto.kind === 'report_discrepancy' ? ['declaredQty', 'observedQty'] : ['quantity'];
    return ['usedQty', 'quantity', 'declaredQty', 'observedQty'].every(
      key => allowed.includes(key) || dto[key] === undefined,
    );
  }

  defaultMessage(): string { return 'Chỉ gửi các trường phù hợp với thao tác đã chọn.'; }
}

export class PartCustodyCommandDto {
  @IsUUID()
  @MaxLength(36)
  partRequestId: string;

  @IsUUID()
  @MaxLength(36)
  partRequestItemId: string;

  @IsIn(['record_usage', 'declare_return', 'accept_return', 'report_discrepancy'])
  @Validate(CustodyCommandFields)
  kind: PartCustodyCommandKind;

  @IsInt()
  @Min(0)
  @Max(MAX_CUSTODY_VERSION)
  expectedVersion: number;

  @IsString()
  @Length(8, 128)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey: string;

  @ValidateIf((dto: PartCustodyCommandDto) => dto.kind === 'record_usage')
  @IsInt()
  @Min(0)
  @Max(MAX_PART_QUANTITY)
  usedQty?: number;

  @ValidateIf((dto: PartCustodyCommandDto) => dto.kind === 'declare_return' || dto.kind === 'accept_return')
  @IsInt()
  @Min(1)
  @Max(MAX_PART_QUANTITY)
  quantity?: number;

  @ValidateIf((dto: PartCustodyCommandDto) => dto.kind === 'report_discrepancy')
  @IsInt()
  @Min(1)
  @Max(MAX_PART_QUANTITY)
  declaredQty?: number;

  @ValidateIf((dto: PartCustodyCommandDto) => dto.kind === 'report_discrepancy')
  @IsInt()
  @Min(0)
  @Max(MAX_PART_QUANTITY)
  observedQty?: number;

  @IsOptional()
  @IsUUID()
  @MaxLength(36)
  evidenceReferenceId?: string;

  @IsOptional()
  @Transform(({ value }) => sanitizeReason(value))
  @IsString()
  @MaxLength(300)
  reason?: string;
}
