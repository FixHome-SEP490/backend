import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { plainToInstance, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsDefined,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
  validateSync,
} from 'class-validator';

export const W3_MAX_REVISION = 2147483647;

export class W3DeliveryPolicyParametersDto {
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  feeCeilingVnd: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  proposalReviewAfterMinutes: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  courierEvidenceReviewAfterMinutes: number;
}

export class CreateW3DeliveryPolicyDraftDto {
  @IsInt()
  @Min(0)
  @Max(0)
  expectedRevision: number;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => W3DeliveryPolicyParametersDto)
  parameters: W3DeliveryPolicyParametersDto;
}

export class ReviseW3DeliveryPolicyDraftDto {
  @IsInt()
  @Min(1)
  @Max(W3_MAX_REVISION)
  expectedRevision: number;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => W3DeliveryPolicyParametersDto)
  parameters: W3DeliveryPolicyParametersDto;
}

export class CreateW3DeliveryPolicyVersionDto {
  @IsInt()
  @Min(0)
  @Max(W3_MAX_REVISION)
  expectedRevision: number;

  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => W3DeliveryPolicyParametersDto)
  parameters: W3DeliveryPolicyParametersDto;
}

export class TransitionW3DeliveryPolicyDto {
  @IsInt()
  @Min(1)
  @Max(W3_MAX_REVISION)
  expectedRevision: number;
}

export class ActivateW3DeliveryPolicyDto extends TransitionW3DeliveryPolicyDto {
  @IsUUID('4')
  previewId: string;

  @Equals(true)
  acknowledged: true;
}

export class W3DeliveryPolicyHistoryDto {
  @ValidateIf((_o, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(W3_MAX_REVISION)
  beforeRevision?: number;

  @ValidateIf((_o, value) => value !== undefined)
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class W3DeliveryPolicyImpactSampleDto {
  @IsString()
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9:_/-]{0,255}$/)
  proposalId: string;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  proposalVersion: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  shippingFeeVnd: number;

  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  proposalAgeMinutes: number;

  @ValidateIf((_o, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  courierEvidenceAgeMinutes: number | null;
}

export class PreviewW3DeliveryPolicyDto {
  @IsUUID('4')
  draftId: string;

  @IsInt()
  @Min(1)
  @Max(W3_MAX_REVISION)
  expectedRevision: number;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => W3DeliveryPolicyImpactSampleDto)
  samples: W3DeliveryPolicyImpactSampleDto[];
}

export class PreviewW3DeliveryPolicyVersionDto extends TransitionW3DeliveryPolicyDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => W3DeliveryPolicyImpactSampleDto)
  samples: W3DeliveryPolicyImpactSampleDto[];
}

const inputPrototypes = [
  Object.prototype,
  null,
  ...[
    W3DeliveryPolicyParametersDto,
    CreateW3DeliveryPolicyDraftDto,
    ReviseW3DeliveryPolicyDraftDto,
    CreateW3DeliveryPolicyVersionDto,
    TransitionW3DeliveryPolicyDto,
    ActivateW3DeliveryPolicyDto,
    PreviewW3DeliveryPolicyVersionDto,
    W3DeliveryPolicyHistoryDto,
    W3DeliveryPolicyImpactSampleDto,
    PreviewW3DeliveryPolicyDto,
  ].map((c) => c.prototype),
];

// Reject accessors/inherited keys/symbols before class-transformer can evaluate them.
function safeInput(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (value === null || typeof value !== 'object')
    return (
      ['string', 'number', 'undefined', 'boolean'].includes(typeof value) ||
      value === null
    );
  if (
    !Array.isArray(value) &&
    !inputPrototypes.includes(Object.getPrototypeOf(value))
  )
    return false;
  if (
    Array.isArray(value) &&
    (value.length > 100 || Object.keys(value).length !== value.length)
  )
    return false;
  return Reflect.ownKeys(value).every((key) => {
    if (Array.isArray(value) && key === 'length') return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === 'string' &&
      !['__proto__', 'constructor', 'prototype'].includes(key) &&
      descriptor.enumerable &&
      'value' in descriptor &&
      safeInput(descriptor.value, depth + 1)
    );
  });
}

/** Also enforced at the service boundary, independent of the global HTTP pipe. */
export function parseW3PolicyDto<T extends object>(
  type: new () => T,
  input: unknown,
): T {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    !safeInput(input)
  )
    throw invalidW3PolicyInput();
  const dto = plainToInstance(type, input, { enableImplicitConversion: false });
  if (
    validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    }).length
  )
    throw invalidW3PolicyInput();
  return dto;
}

export function invalidW3PolicyInput() {
  return new BadRequestException({
    code: 'W3_DELIVERY_POLICY_INVALID_INPUT',
    message: 'Dữ liệu bản nháp chính sách giao hàng không hợp lệ.',
  });
}

/** Runs after auth/permissions, before global pipes can remove dangerous raw keys. */
@Injectable()
export class W3DeliveryPolicyInputGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (
      (request.body !== undefined && !safeInput(request.body)) ||
      (request.query !== undefined && !safeInput(request.query))
    )
      throw invalidW3PolicyInput();
    return true;
  }
}
