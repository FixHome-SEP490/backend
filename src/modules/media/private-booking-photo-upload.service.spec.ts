import { BadRequestException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { Repository } from 'typeorm';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Role } from '../../shared/enums';
import { PrivateBookingPhotoUpload } from './entities/private-booking-photo-upload.entity';
import { PrivateBookingPhotoUploadService } from './private-booking-photo-upload.service';
import { PrivateBookingPhotoStorage } from './private-booking-photo-storage.service';

const OWNER_ID = '7f2fd9d2-e616-4d44-b2c3-9be271029eba';
const UPLOAD_ID = '25b11d61-7c97-4a29-a53b-97ca76ac3435';
const OBJECT_REF = `storage://booking-private/${OWNER_ID}/2debcf6f-1df5-488d-ae63-48ecbe44af45`;
const PNG_BYTES = Buffer.from('89504e470d0a1a0a00', 'hex');
const PNG_FILE = { buffer: PNG_BYTES, mimetype: 'image/png', size: PNG_BYTES.length };
const FIXED_NOW = new Date('2026-09-21T12:00:00.000Z');

describe('PrivateBookingPhotoUploadService', () => {
  let service: PrivateBookingPhotoUploadService;
  let storage: { validate: ReturnType<typeof vi.fn>; upload: ReturnType<typeof vi.fn> };
  let repository: {
    create: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    storage = {
      validate: vi.fn(),
      upload: vi.fn().mockResolvedValue(OBJECT_REF),
    };
    repository = {
      create: vi.fn((metadata) => metadata),
      save: vi.fn(async (metadata) => ({ ...metadata, id: UPLOAD_ID })),
    };
    service = new PrivateBookingPhotoUploadService(
      repository as unknown as Repository<PrivateBookingPhotoUpload>,
      storage as unknown as PrivateBookingPhotoStorage,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('rejects a non-customer before validating or calling private storage', async () => {
    const providerFactory = vi.spyOn(axios, 'create');

    await expect(service.upload(Role.TECHNICIAN, OWNER_ID, PNG_FILE)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(storage.validate).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('rejects an invalid file before upload or persistence', async () => {
    const providerFactory = vi.spyOn(axios, 'create');
    storage.validate.mockImplementation(() => {
      throw new BadRequestException('Invalid booking photo');
    });

    await expect(service.upload(Role.CUSTOMER, OWNER_ID, PNG_FILE)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(storage.validate).toHaveBeenCalledWith(PNG_FILE);
    expect(storage.upload).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('persists owner provenance and two-hour expiry while returning only upload ID and safe metadata', async () => {
    const providerFactory = vi.spyOn(axios, 'create');

    const result = await service.upload(Role.CUSTOMER, OWNER_ID, PNG_FILE);

    expect(storage.validate).toHaveBeenCalledWith(PNG_FILE);
    expect(storage.upload).toHaveBeenCalledWith(OWNER_ID, PNG_FILE);
    expect(repository.create).toHaveBeenCalledWith({
      ownerUserId: OWNER_ID,
      objectRef: OBJECT_REF,
      mimeType: 'image/png',
      sizeBytes: PNG_BYTES.length,
      expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000),
      claimedBookingId: null,
    });
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      uploadId: UPLOAD_ID,
      mimeType: 'image/png',
      sizeBytes: PNG_BYTES.length,
    });
    expect(Object.keys(result).sort()).toEqual(['mimeType', 'sizeBytes', 'uploadId']);
    expect(JSON.stringify(result)).not.toContain('storage://');
    expect(JSON.stringify(result)).not.toContain('https://');
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('sanitizes storage errors without returning provider details or attempting a real provider call', async () => {
    const providerFactory = vi.spyOn(axios, 'create');
    storage.upload.mockRejectedValue(
      new Error(`403 provider failure for ${OBJECT_REF} with service-role-secret`),
    );

    const error = await service.upload(Role.CUSTOMER, OWNER_ID, PNG_FILE).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).not.toContain(OBJECT_REF);
    expect((error as Error).message).not.toContain('service-role-secret');
    expect(repository.save).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it('sanitizes metadata-save failures and leaves the uploaded private object for planned cleanup', async () => {
    const providerFactory = vi.spyOn(axios, 'create');
    repository.save.mockRejectedValue(
      new Error(`database rejected ${OBJECT_REF} with connection-secret`),
    );

    const error = await service.upload(Role.CUSTOMER, OWNER_ID, PNG_FILE).catch(
      (caught: unknown) => caught,
    );

    expect(storage.upload).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).not.toContain(OBJECT_REF);
    expect((error as Error).message).not.toContain('connection-secret');
    expect(providerFactory).not.toHaveBeenCalled();
    expect(storage).not.toHaveProperty('delete');
  });
});
