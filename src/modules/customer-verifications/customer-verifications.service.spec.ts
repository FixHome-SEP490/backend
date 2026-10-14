import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AccountStatus, Role, VerificationStatus } from '../../shared/enums';
import { User } from '../users/entities/user.entity';
import { AdminCustomerVerificationsController } from './admin-customer-verifications.controller';
import { CustomerVerificationsService } from './customer-verifications.service';
import { SubmitCustomerVerificationDto } from './dto/customer-verification.dto';
import { CustomerVerificationDocument } from './entities/customer-verification-document.entity';

const CUSTOMER_ID = '6f1c2e2a-6b2a-4a1b-9c3d-2e6f1a2b3c4d';
const ADMIN_ID = 'admin-1';

const validBody = () => ({
  fullName: 'Nguyễn Văn An',
  dateOfBirth: '1995-06-15',
  gender: 'male',
  citizenIdNumber: '079123456789',
  address: '12 Nguyễn Trãi, Phường Bến Thành, TP. Hồ Chí Minh',
  documents: [
    { documentType: 'citizen_id_front', storageObjectPath: `kyc/${CUSTOMER_ID}/front.jpg`, fileName: 'mat-truoc.jpg', fileSize: 2048, mimeType: 'image/jpeg' },
    { documentType: 'citizen_id_back', storageObjectPath: `kyc/${CUSTOMER_ID}/back.png`, fileName: 'mat-sau.png', fileSize: 2048, mimeType: 'image/png' },
  ],
});

async function dtoErrors(body: object): Promise<string[]> {
  const dto = plainToInstance(SubmitCustomerVerificationDto, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  const props: string[] = [];
  const walk = (list: typeof errors, prefix = '') =>
    list.forEach((e) => {
      if (e.constraints) props.push(prefix + e.property);
      if (e.children?.length) walk(e.children, `${prefix}${e.property}.`);
    });
  walk(errors);
  return props;
}

describe('Customer KYC request validation (PO 14/10/2026)', () => {
  it('accepts a correct submission', async () => {
    expect(await dtoErrors(validBody())).toEqual([]);
  });

  it.each([
    ['emoji in the name', { fullName: 'Nguyễn Văn An 😀' }, 'fullName'],
    ['digits in the name', { fullName: 'Nguyen Van 4n' }, 'fullName'],
    ['control character in the name', { fullName: 'Nguyen\u0000An' }, 'fullName'],
    ['invisible character in the name', { fullName: 'Nguyen​An' }, 'fullName'],
    ['emoji in the address', { address: '12 Nguyễn Trãi 🏠' }, 'address'],
    ['HTML in the address', { address: '<b>12 Nguyen Trai</b>' }, 'address'],
    ['a too long address', { address: 'a'.repeat(501) }, 'address'],
    ['a CCCD of 11 digits', { citizenIdNumber: '07912345678' }, 'citizenIdNumber'],
    ['a CCCD of 13 digits', { citizenIdNumber: '0791234567890' }, 'citizenIdNumber'],
    ['a CCCD with letters', { citizenIdNumber: '07912345678A' }, 'citizenIdNumber'],
    ['a date that does not exist', { dateOfBirth: '2000-02-30' }, 'dateOfBirth'],
    ['a date with time', { dateOfBirth: '2000-01-01T00:00:00Z' }, 'dateOfBirth'],
    ['an unknown gender', { gender: 'unknown' }, 'gender'],
  ])('rejects %s', async (_label, change, property) => {
    expect(await dtoErrors({ ...validBody(), ...change })).toContain(property);
  });

  it('accepts only image documents up to 10 MB, front or back', async () => {
    const base = validBody();
    const withDoc = (patch: object) => ({ ...base, documents: [{ ...base.documents[0], ...patch }, base.documents[1]] });
    expect(await dtoErrors(withDoc({ mimeType: 'application/pdf', fileName: 'cccd.pdf' }))).toContain('documents.0.mimeType');
    expect(await dtoErrors(withDoc({ mimeType: 'video/mp4', fileName: 'cccd.mp4' }))).toContain('documents.0.mimeType');
    expect(await dtoErrors(withDoc({ fileSize: 10 * 1024 * 1024 + 1 }))).toContain('documents.0.fileSize');
    expect(await dtoErrors(withDoc({ documentType: 'face_photo' }))).toContain('documents.0.documentType');
    expect(await dtoErrors({ ...base, documents: [base.documents[0]] })).toContain('documents');
    expect(await dtoErrors({ ...base, documents: [...base.documents, base.documents[0]] })).toContain('documents');
  });
});

describe('CustomerVerificationsService', () => {
  let verifications: any[];
  let documents: any[];
  let users: Record<string, any>;
  let audit: { logWithManagerStrict: ReturnType<typeof vi.fn> };
  let notifications: { createNotification: ReturnType<typeof vi.fn> };
  let storage: any;
  let cccdTaken: boolean;
  let service: CustomerVerificationsService;

  const statusMatch = (row: any, where: any) =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  beforeEach(() => {
    verifications = [];
    documents = [];
    cccdTaken = false;
    users = {
      [CUSTOMER_ID]: {
        id: CUSTOMER_ID, role: Role.CUSTOMER, status: AccountStatus.ACTIVE, isActive: true,
        fullName: 'Ten Cu', dateOfBirth: null, gender: null, citizenIdNumber: null, fullAddress: null,
      },
    };
    const verificationRepo: any = {
      findOne: vi.fn(async ({ where }: any) => {
        const list = Array.isArray(where) ? where : [where];
        const found = [...verifications].reverse().find((v) => list.some((w: any) => statusMatch(v, w)));
        return found ? { ...found, documents: documents.filter((d) => d.verificationId === found.id) } : null;
      }),
      create: vi.fn((v: any) => ({ ...v })),
      save: vi.fn(async (v: any) => {
        const row = { id: `ver-${verifications.length + 1}`, createdAt: new Date(), ...v };
        verifications.push(row);
        return { ...row };
      }),
      update: vi.fn(async (criteria: any, values: any) => {
        let affected = 0;
        verifications.forEach((v, i) => {
          if (statusMatch(v, criteria)) { verifications[i] = { ...v, ...values }; affected++; }
        });
        return { affected };
      }),
    };
    const documentRepo: any = {
      create: vi.fn((d: any) => ({ ...d })),
      save: vi.fn(async (list: any[]) => list.map((d) => { const row = { id: `doc-${documents.length + 1}`, ...d }; documents.push(row); return row; })),
      findOne: vi.fn(async ({ where }: any) => {
        const d = documents.find((x) => statusMatch(x, where));
        return d ? { ...d, verification: verifications.find((v) => v.id === d.verificationId) } : null;
      }),
    };
    const userRepo: any = {
      findOne: vi.fn(async ({ where }: any) => (users[where.id] ? { ...users[where.id] } : null)),
      update: vi.fn(async (id: string, values: any) => { users[id] = { ...users[id], ...values }; }),
      createQueryBuilder: vi.fn(() => {
        const qb: any = { where: () => qb, andWhere: () => qb, getExists: async () => cccdTaken };
        return qb;
      }),
    };
    const manager: any = {
      getRepository: (entity: unknown) =>
        entity === User ? userRepo : entity === CustomerVerificationDocument ? documentRepo : verificationRepo,
    };
    manager.transaction = async (fn: any) => fn(manager);
    verificationRepo.manager = manager;
    storage = {
      validateObjectPath: vi.fn((path: string, owner: string) => {
        const parts = path.split('/');
        if (parts.length !== 3 || parts[0] !== 'kyc' || parts[1] !== owner) throw new BadRequestException('bad path');
      }),
      createSignedUploadUrl: vi.fn(async () => ({ storageObjectPath: `kyc/${CUSTOMER_ID}/x.jpg` })),
      createSignedAccess: vi.fn(async () => ({ signedUrl: 'https://signed', expiresIn: 300, expiresAt: '' })),
    };
    audit = { logWithManagerStrict: vi.fn(async () => undefined) };
    notifications = { createNotification: vi.fn(async () => ({})) };
    service = new CustomerVerificationsService(verificationRepo, documentRepo, storage, audit as never, notifications as never);
  });

  const submit = (patch: object = {}) =>
    service.submit(CUSTOMER_ID, plainToInstance(SubmitCustomerVerificationDto, { ...validBody(), ...patch }));

  it('submits PENDING, snapshots the details and writes them to the profile', async () => {
    const state = await submit({ fullName: '  Nguyễn   Văn An ' });
    expect(state.status).toBe('pending');
    expect(verifications[0]).toMatchObject({
      status: VerificationStatus.PENDING, fullName: 'Nguyễn Văn An', dateOfBirth: '1995-06-15',
      gender: 'male', citizenIdNumber: '079123456789', fullAddress: validBody().address, verifiedFullName: null,
    });
    expect(documents.map((d) => d.documentType)).toEqual(['citizen_id_front', 'citizen_id_back']);
    expect(users[CUSTOMER_ID]).toMatchObject({
      fullName: 'Nguyễn Văn An', dateOfBirth: '1995-06-15', gender: 'male',
      citizenIdNumber: '079123456789', fullAddress: validBody().address,
    });
    expect(audit.logWithManagerStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'CUSTOMER_KYC_SUBMITTED' }));
  });

  it('needs exactly the front and the back of the card', async () => {
    const [front, back] = validBody().documents;
    await expect(submit({ documents: [front, { ...back, documentType: 'citizen_id_front' }] })).rejects.toThrow('mặt trước và mặt sau');
    await expect(submit({ documents: [front, { ...back, storageObjectPath: front.storageObjectPath }] })).rejects.toThrow('hai ảnh khác nhau');
    expect(verifications).toHaveLength(0);
  });

  it("refuses a file outside the customer's own kyc/<id>/ prefix", async () => {
    const [front, back] = validBody().documents;
    await expect(submit({ documents: [{ ...front, storageObjectPath: 'kyc/other-user/front.jpg' }, back] })).rejects.toThrow('không thuộc hồ sơ của bạn');
    expect(verifications).toHaveLength(0);
  });

  it('refuses a file name or path whose extension does not match the image type', async () => {
    const [front, back] = validBody().documents;
    await expect(submit({ documents: [{ ...front, fileName: 'mat-truoc.png' }, back] })).rejects.toThrow('Định dạng ảnh');
    await expect(submit({ documents: [{ ...front, storageObjectPath: `kyc/${CUSTOMER_ID}/front.pdf` }, back] })).rejects.toThrow('Định dạng ảnh');
  });

  it('applies the technician age rule (18) and refuses impossible birth dates', async () => {
    const now = new Date();
    const seventeen = `${now.getUTCFullYear() - 17}-01-01`;
    await expect(submit({ dateOfBirth: seventeen })).rejects.toThrow('đủ 18 tuổi');
    await expect(submit({ dateOfBirth: `${now.getUTCFullYear() + 1}-01-01` })).rejects.toThrow(BusinessException);
    await expect(submit({ dateOfBirth: '1899-12-31' })).rejects.toThrow('Ngày sinh không hợp lệ');
  });

  it('refuses a CCCD number already used by another account', async () => {
    cccdTaken = true;
    await expect(submit()).rejects.toThrow('đã được sử dụng');
    expect(users[CUSTOMER_ID].fullName).toBe('Ten Cu');
  });

  it('refuses a second submission while one is pending or after approval, and allows one after a rejection', async () => {
    await submit();
    await expect(submit()).rejects.toThrow(ConflictException);
    await service.reject('ver-1', ADMIN_ID, 'Ảnh mờ, chụp lại giúp');
    await submit({ fullName: 'Nguyễn Văn Bình' });
    expect(verifications).toHaveLength(2);
    await service.approve('ver-2', ADMIN_ID);
    await expect(submit()).rejects.toThrow('đã được xác minh');
  });

  it('only lets an active customer account submit', async () => {
    users[CUSTOMER_ID].status = AccountStatus.LOCKED;
    await expect(submit()).rejects.toThrow(ForbiddenException);
    users[CUSTOMER_ID] = { ...users[CUSTOMER_ID], status: AccountStatus.ACTIVE, role: Role.TECHNICIAN };
    await expect(submit()).rejects.toThrow(ForbiddenException);
  });

  it('approval freezes the confirmed name, restores the checked details on the profile and notifies', async () => {
    await submit();
    users[CUSTOMER_ID].fullName = 'Sửa Trong Lúc Chờ';
    const view = await service.approve('ver-1', ADMIN_ID);
    expect(verifications[0]).toMatchObject({ status: 'verified', reviewedById: ADMIN_ID, verifiedFullName: 'Nguyễn Văn An' });
    expect(users[CUSTOMER_ID].fullName).toBe('Nguyễn Văn An');
    expect(view.status).toBe('verified');
    expect(audit.logWithManagerStrict).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'CUSTOMER_KYC_APPROVED', actorRole: Role.ADMIN }));
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: CUSTOMER_ID, type: 'CUSTOMER_KYC_APPROVED' }));
    await expect(service.approve('ver-1', ADMIN_ID)).rejects.toThrow(ConflictException);
    expect(await service.requireVerifiedName(CUSTOMER_ID, 'withdraw')).toBe('Nguyễn Văn An');
  });

  it('rejection needs a reason of 5 characters, keeps the reason and notifies', async () => {
    await submit();
    await expect(service.reject('ver-1', ADMIN_ID, ' abc ')).rejects.toThrow('tối thiểu 5 ký tự');
    await service.reject('ver-1', ADMIN_ID, 'Ảnh CCCD bị mờ');
    expect(verifications[0]).toMatchObject({ status: 'rejected', rejectionReason: 'Ảnh CCCD bị mờ', verifiedFullName: null });
    expect(notifications.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'CUSTOMER_KYC_REJECTED', message: expect.stringContaining('Ảnh CCCD bị mờ') }));
    expect((await service.getMine(CUSTOMER_ID)).rejectionReason).toBe('Ảnh CCCD bị mờ');
  });

  it('says what to do next when the bank account or the withdrawal needs KYC', async () => {
    await expect(service.requireVerifiedName(CUSTOMER_ID, 'bank_account')).rejects.toThrow('Bạn cần xác minh danh tính');
    await submit();
    await expect(service.requireVerifiedName(CUSTOMER_ID, 'withdraw')).rejects.toThrow('đang chờ duyệt');
    await service.reject('ver-1', ADMIN_ID, 'Thiếu mặt sau rõ nét');
    await expect(service.requireVerifiedName(CUSTOMER_ID, 'withdraw')).rejects.toThrow('gửi lại hồ sơ');
  });

  it("serves a document only to its owner, someone else's reads as missing", async () => {
    await submit();
    await expect(service.getMyDocumentAccess('someone-else', 'doc-1')).rejects.toThrow('Không tìm thấy giấy tờ');
    await expect(service.getMyDocumentAccess(CUSTOMER_ID, 'doc-1')).resolves.toMatchObject({ signedUrl: 'https://signed' });
    expect(storage.createSignedAccess).toHaveBeenCalledWith(`kyc/${CUSTOMER_ID}/front.jpg`, CUSTOMER_ID);
  });
});

describe('Customer KYC review is admin only (BRX-041)', () => {
  const guard = new RolesGuard(new Reflector());
  const contextFor = (role: Role, handler: keyof AdminCustomerVerificationsController) =>
    ({
      getHandler: () => AdminCustomerVerificationsController.prototype[handler],
      getClass: () => AdminCustomerVerificationsController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', role } }) }),
    }) as unknown as ExecutionContext;

  it.each(['list', 'detail', 'documentAccess', 'approve', 'reject'] as const)('%s: admin passes, service manager and others do not', (handler) => {
    expect(guard.canActivate(contextFor(Role.ADMIN, handler))).toBe(true);
    for (const role of [Role.SERVICE_MANAGER, Role.CUSTOMER, Role.TECHNICIAN]) {
      expect(() => guard.canActivate(contextFor(role, handler))).toThrow(ForbiddenException);
    }
  });
});
