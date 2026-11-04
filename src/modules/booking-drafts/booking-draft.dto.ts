import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { IsDefined, IsInt, IsObject, IsUUID, Max, Min, Validate, ValidatorConstraint,
  type ValidatorConstraintInterface, validateSync } from 'class-validator';
import { BookingDeviceAttributesDto, CreateBookingDto, UUID_REGEX } from '../bookings/booking.dto';
import { CreateVisitGroupDto } from '../visit-groups/visit-group.dto';
import { UrgencyLevel } from '../../shared/enums';

/** No UI objects, price promises, addresses, URLs, files or AI history. */
export interface SafeDraftSnapshot {
  kind?: 'booking' | 'visit_group';
  savedDeviceCount?: number;
  quantity?: number;
  step?: number;
  addressId?: string;
  mode?: 'scheduled' | 'urgent';
  date?: string;
  slot?: 'morning' | 'afternoon' | 'evening';
  preferredStartAt?: string;
  preferredEndAt?: string;
  customerNote?: string;
  urgency?: UrgencyLevel;
  items?: SafeDraftItem[];
}

export interface SafeDraftItem {
  serviceId?: string;
  deviceLabel?: string;
  description?: string;
  deviceAttributes?: BookingDeviceAttributesDto;
  selectedVariantCode?: string;
  photoUploadIds?: string[];
}

const invalid = (): never => { throw new BadRequestException('Nội dung bản nháp không hợp lệ.'); };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Bound work BEFORE transformation/recursive validation/stringification, also for submit DTOs. */
export function assertBoundedDraftJson(value: unknown): void {
  let nodes = 0;
  const walk = (child: unknown, depth: number): void => {
    if (++nodes > 512 || depth > 8) invalid();
    if (typeof child === 'string') { if (child.length > 5000) invalid(); return; }
    if (child === null || typeof child === 'boolean' || (typeof child === 'number' && Number.isFinite(child))) return;
    if (Array.isArray(child)) {
      if (child.length > 35) invalid();
      child.forEach(item => walk(item, depth + 1));
    } else if (isRecord(child)) {
      const keys = Object.keys(child);
      if (keys.length > 32 || keys.some(key => key.length > 64 || ['__proto__', 'constructor', 'prototype'].includes(key))) invalid();
      keys.forEach(key => walk(child[key], depth + 1));
    } else invalid();
  };
  walk(value, 0);
  // Leave headroom for PostgreSQL jsonb's whitespace in its 64 KiB constraint.
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 60 * 1024) {
    throw new PayloadTooLargeException('Nội dung bản nháp quá lớn.');
  }
}

function only(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}

function text(value: unknown, max: number, pattern?: RegExp): string {
  if (typeof value !== 'string') return invalid();
  if (value.length > max
    || [...value].some(character => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
    })
    || /(?:https?:|data:|blob:|file:|www\.)/i.test(value)
    || (pattern && !pattern.test(value))) invalid();
  return value;
}

function uuid(value: unknown): string { return text(value, 36, UUID_REGEX).toLowerCase(); }

function dto<T extends object>(type: ClassConstructor<T>, value: unknown): T {
  if (!isRecord(value)) invalid();
  const instance = plainToInstance(type, value);
  if (validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true }).length) invalid();
  return instance;
}

export function parseSafeDraftSnapshot(value: unknown): SafeDraftSnapshot {
  assertBoundedDraftJson(value);
  only(value, ['kind', 'savedDeviceCount', 'quantity', 'step', 'addressId', 'mode', 'date', 'slot', 'preferredStartAt', 'preferredEndAt', 'customerNote', 'urgency', 'items']);
  const result: SafeDraftSnapshot = {};
  if ('kind' in value) {
    if (!['booking', 'visit_group'].includes(value.kind as string)) invalid();
    result.kind = value.kind as SafeDraftSnapshot['kind'];
  }
  for (const [key, min, max] of [['savedDeviceCount', 0, 5], ['quantity', 1, 1000], ['step', 1, 4]] as const) {
    if (key in value) {
      if (!Number.isInteger(value[key]) || (value[key] as number) < min || (value[key] as number) > max) invalid();
      result[key] = value[key] as number;
    }
  }
  if ('addressId' in value) result.addressId = uuid(value.addressId);
  if ('mode' in value) {
    if (!['scheduled', 'urgent'].includes(value.mode as string)) invalid();
    result.mode = value.mode as SafeDraftSnapshot['mode'];
  }
  if ('date' in value) result.date = text(value.date, 10, /^\d{4}-\d{2}-\d{2}$/);
  if ('slot' in value) {
    if (!['morning', 'afternoon', 'evening'].includes(value.slot as string)) invalid();
    result.slot = value.slot as SafeDraftSnapshot['slot'];
  }
  for (const key of ['preferredStartAt', 'preferredEndAt'] as const) {
    if (key in value) {
      const timestamp = text(value[key], 35, /^\d{4}-\d{2}-\d{2}T/);
      if (!Number.isFinite(Date.parse(timestamp))) invalid();
      result[key] = timestamp;
    }
  }
  if ('customerNote' in value) result.customerNote = text(value.customerNote, 1000);
  if ('urgency' in value) {
    if (!Object.values(UrgencyLevel).includes(value.urgency as UrgencyLevel)) invalid();
    result.urgency = value.urgency as UrgencyLevel;
  }
  if ('items' in value) {
    if (!Array.isArray(value.items) || value.items.length > 5) invalid();
    result.items = (value.items as unknown[]).map(item => {
      only(item, ['serviceId', 'deviceLabel', 'description', 'deviceAttributes', 'selectedVariantCode', 'photoUploadIds']);
      const safe: SafeDraftItem = {};
      if ('serviceId' in item) safe.serviceId = uuid(item.serviceId);
      if ('deviceLabel' in item) safe.deviceLabel = text(item.deviceLabel, 80);
      if ('description' in item) safe.description = text(item.description, 5000);
      if ('selectedVariantCode' in item && item.selectedVariantCode !== null) safe.selectedVariantCode = text(item.selectedVariantCode, 20, /^[A-Z]{2}-\d{2}-\d{2}$/);
      if ('deviceAttributes' in item) {
        only(item.deviceAttributes, ['brand', 'acMounting', 'acHorsepower', 'washerLoadingStyle', 'washerCapacityKg', 'washerHasDryer']);
        if ('brand' in item.deviceAttributes) text(item.deviceAttributes.brand, 64);
        // Plain JSON only; never persist a transformed DTO prototype.
        dto(BookingDeviceAttributesDto, item.deviceAttributes);
        safe.deviceAttributes = { ...item.deviceAttributes };
      }
      if ('photoUploadIds' in item) {
        if (!Array.isArray(item.photoUploadIds) || item.photoUploadIds.length > 7) invalid();
        safe.photoUploadIds = (item.photoUploadIds as unknown[]).map(uuid);
        if (new Set(safe.photoUploadIds).size !== safe.photoUploadIds.length) invalid();
      }
      return safe;
    });
  }
  if (result.savedDeviceCount !== undefined) {
    const count = result.items?.length ?? 0;
    if (result.savedDeviceCount > count || count > result.savedDeviceCount + 1) invalid();
  }
  return result;
}

export type DraftSubmitRequest = { kind: 'booking'; data: CreateBookingDto }
  | { kind: 'visit_group'; data: CreateVisitGroupDto };

export function parseDraftSubmit(value: unknown): DraftSubmitRequest {
  assertBoundedDraftJson(value);
  only(value, ['kind', 'data']);
  if (value.kind === 'booking') return { kind: 'booking', data: dto(CreateBookingDto, value.data) };
  if (value.kind === 'visit_group') {
    const data = dto(CreateVisitGroupDto, value.data);
    if (data.items.length > 5) invalid();
    return { kind: 'visit_group', data };
  }
  return invalid();
}

export function validDraftVersion(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) < 2147483647;
}

@ValidatorConstraint({ name: 'draftExpectedVersion', async: false })
class DraftExpectedVersion implements ValidatorConstraintInterface {
  validate(value: unknown): boolean { return value === null || validDraftVersion(value); }
  defaultMessage(): string { return 'expectedVersion phải là null hoặc số phiên bản hợp lệ.'; }
}

export class SaveBookingDraftDto {
  @IsDefined() @IsObject()
  snapshot: SafeDraftSnapshot;

  @Validate(DraftExpectedVersion)
  expectedVersion: number | null;
}

export class SubmitBookingDraftDto {
  @IsInt() @Min(1) @Max(2147483646)
  expectedVersion: number;

  @IsUUID('4')
  operationKey: string;

  @IsDefined() @IsObject()
  request: DraftSubmitRequest;
}
