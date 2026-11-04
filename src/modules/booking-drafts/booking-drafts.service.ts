import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { Role } from '../../shared/enums';
import { BookingsService } from '../bookings/bookings.service';
import { VisitGroupsService } from '../visit-groups/visit-groups.service';
import { lockPendingVisitCustomer } from '../bookings/pending-visit-quota';
import { UUID_REGEX } from '../bookings/booking.dto';
import { Address } from '../users/entities/address.entity';
import { PrivateBookingPhotoUpload } from '../media/entities/private-booking-photo-upload.entity';
import { BookingDraft } from './entities/booking-draft.entity';
import { BookingDraftSubmitReceipt } from './entities/booking-draft-submit-receipt.entity';
import { parseDraftSubmit, parseSafeDraftSnapshot, validDraftVersion, type SafeDraftSnapshot,
  type SaveBookingDraftDto, type SubmitBookingDraftDto } from './booking-draft.dto';

type Customer = { id: string; role: string };
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const conflict = (): never => { throw new ConflictException('Bản nháp đã thay đổi, hết hạn hoặc đã được gửi. Vui lòng tải lại.'); };

/** Sorted object keys, preserving array order and absent/null distinctions of the submitted JSON. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonical(value[key])]));
  return value;
}

@Injectable()
export class BookingDraftsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly bookings: BookingsService,
    private readonly visitGroups: VisitGroupsService,
  ) {}

  async current(customer: Customer) {
    this.assertCustomer(customer);
    return this.dataSource.transaction(async manager => {
      await lockPendingVisitCustomer(manager, customer.id);
      const draft = await this.lockDraft(manager, customer.id);
      if (!this.active(draft)) return null;
      const snapshot = await this.safeReferences(manager, customer.id, draft.snapshot, false);
      return this.present(draft, snapshot);
    });
  }

  async save(dto: SaveBookingDraftDto, customer: Customer) {
    this.assertCustomer(customer);
    if (!dto || (dto.expectedVersion !== null && !validDraftVersion(dto.expectedVersion))) {
      throw new BadRequestException('Phiên bản bản nháp không hợp lệ.');
    }
    const input = parseSafeDraftSnapshot(dto.snapshot);
    return this.dataSource.transaction(async manager => {
      await lockPendingVisitCustomer(manager, customer.id);
      let draft = await this.lockDraft(manager, customer.id);
      if (this.active(draft)) {
        if (dto.expectedVersion !== draft.version) conflict();
      } else {
        if (dto.expectedVersion !== null) conflict();
        if (draft) await manager.delete(BookingDraft, { id: draft.id, customerId: customer.id });
        draft = null;
      }
      const snapshot = await this.safeReferences(manager, customer.id, input, true);
      // Clock starts after successful validation; the transaction must still commit to persist it.
      const now = new Date();
      const value = draft ? { ...draft, version: draft.version + 1, snapshot, updatedAt: now }
        : manager.create(BookingDraft, { customerId: customer.id, version: 1, snapshot, createdAt: now, updatedAt: now });
      value.expiresAt = new Date(now.getTime() + THIRTY_DAYS_MS);
      const saved = await manager.save(BookingDraft, value);
      return this.present(saved, snapshot);
    });
  }

  async discard(customer: Customer) {
    this.assertCustomer(customer);
    return this.dataSource.transaction(async manager => {
      await lockPendingVisitCustomer(manager, customer.id);
      const draft = await this.lockDraft(manager, customer.id);
      const deleted = this.active(draft);
      if (draft) await manager.delete(BookingDraft, { id: draft.id, customerId: customer.id });
      return { deleted };
    });
  }

  async submit(draftId: string, dto: SubmitBookingDraftDto, customer: Customer) {
    this.assertCustomer(customer);
    if (!UUID_REGEX.test(draftId) || !dto || !validDraftVersion(dto.expectedVersion) || !isUUID(dto.operationKey, '4')) {
      throw new BadRequestException('Yêu cầu gửi bản nháp không hợp lệ.');
    }
    // Validate both DTO branches before any expensive transaction. Availability/price/time/ownership
    // are revalidated by the EXISTING create service only for a new submit, never for a receipt replay.
    const request = parseDraftSubmit(dto.request);
    const requestFingerprint = createHash('sha256').update(JSON.stringify(canonical({
      expectedVersion: dto.expectedVersion, request: dto.request,
    }))).digest('hex');
    const id = draftId.toLowerCase();
    const operationKey = dto.operationKey.toLowerCase();
    return this.dataSource.transaction(async manager => {
      await lockPendingVisitCustomer(manager, customer.id);
      // ALWAYS before checking the active generation: a retry of A must not inspect/consume B.
      const receipt = await manager.findOneBy(BookingDraftSubmitReceipt, {
        customerId: customer.id, draftId: id, operationKey,
      });
      if (receipt) {
        if (receipt.requestFingerprint !== requestFingerprint) {
          throw new ConflictException('Mã xác nhận đã được dùng với nội dung khác.');
        }
        return this.result(receipt);
      }
      const draft = await this.lockDraft(manager, customer.id);
      if (!this.active(draft) || draft.id !== id || draft.version !== dto.expectedVersion) conflict();
      let bookingId: string | null = null;
      let visitGroupId: string | null = null;
      if (request.kind === 'booking') {
        const booking = await this.bookings.create(request.data, customer, { manager, visitGroupId: null });
        bookingId = booking.id;
      } else {
        // The draft operation is the sole idempotency authority. A client-supplied group key
        // could otherwise select an unrelated old group before fresh validation/quota checks.
        const { idempotencyKey: _key, ...data } = request.data;
        const group = await this.visitGroups.create(data, customer, manager);
        visitGroupId = group.id;
      }
      const now = new Date();
      const result = this.result({ kind: request.kind, bookingId, visitGroupId });
      await manager.save(BookingDraftSubmitReceipt, manager.create(BookingDraftSubmitReceipt, {
        customerId: customer.id, draftId: id, operationKey, requestFingerprint,
        ...result, createdAt: now, retainUntil: new Date(now.getTime() + THIRTY_DAYS_MS),
      }));
      const consumed = await manager.delete(BookingDraft, { id, customerId: customer.id, version: dto.expectedVersion });
      if (consumed.affected !== 1) conflict();
      return result;
    });
  }

  private assertCustomer(customer: Customer): void {
    if (!customer || customer.role !== Role.CUSTOMER || !UUID_REGEX.test(customer.id)) {
      throw new ForbiddenException('Chỉ khách hàng được sử dụng bản nháp đặt lịch.');
    }
  }

  private lockDraft(manager: EntityManager, customerId: string): Promise<BookingDraft | null> {
    return manager.findOne(BookingDraft, { where: { customerId }, lock: { mode: 'pessimistic_write' } });
  }

  private active(draft: BookingDraft | null): boolean {
    return !!draft && draft.expiresAt instanceof Date && draft.expiresAt.getTime() > Date.now();
  }

  private present(draft: BookingDraft, snapshot: SafeDraftSnapshot) {
    return { id: draft.id, version: draft.version, expiresAt: draft.expiresAt.toISOString(), snapshot };
  }

  private result(value: Pick<BookingDraftSubmitReceipt, 'kind' | 'bookingId' | 'visitGroupId'>) {
    if (!((value.kind === 'booking' && UUID_REGEX.test(value.bookingId ?? '') && value.visitGroupId === null)
      || (value.kind === 'visit_group' && UUID_REGEX.test(value.visitGroupId ?? '') && value.bookingId === null))) conflict();
    return { kind: value.kind, bookingId: value.bookingId, visitGroupId: value.visitGroupId };
  }

  private async safeReferences(manager: EntityManager, customerId: string, input: SafeDraftSnapshot, saving: boolean) {
    const snapshot = parseSafeDraftSnapshot(input);
    if (snapshot.addressId && !await manager.findOneBy(Address, { id: snapshot.addressId, userId: customerId })) {
      if (saving) throw new ForbiddenException('Địa chỉ không thuộc tài khoản hoặc không còn khả dụng.');
      delete snapshot.addressId;
    }
    // Read references only. No claims, signing, remote storage, quota or TTL updates on Save/GET.
    for (const item of snapshot.items ?? []) {
      if (!item.photoUploadIds) continue;
      const available: string[] = [];
      for (const id of item.photoUploadIds) {
        const upload = await manager.findOneBy(PrivateBookingPhotoUpload, { id, ownerUserId: customerId });
        if (upload && upload.claimedBookingId === null && upload.expiresAt instanceof Date && upload.expiresAt.getTime() > Date.now()) {
          available.push(id);
        }
      }
      item.photoUploadIds = available;
    }
    return snapshot;
  }
}
