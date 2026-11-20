import { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import { KycOrphanSweepService } from './kyc-orphan-sweep.service';
import { KycStorageService } from './kyc-storage.service';

describe('KycOrphanSweepService', () => {
  it('removes the objects no document points to', async () => {
    const dataSource = { query: vi.fn().mockResolvedValue([{ name: 'kyc/u/1.jpg' }, { name: 'kyc/u/2.jpg' }]) };
    const storage = { remove: vi.fn().mockResolvedValue(undefined) };
    const service = new KycOrphanSweepService(dataSource as unknown as DataSource, storage as unknown as KycStorageService);

    expect(await service.sweep()).toBe(2);
    expect(storage.remove).toHaveBeenCalledWith(['kyc/u/1.jpg', 'kyc/u/2.jpg']);
    expect(dataSource.query.mock.calls[0][0]).toContain('verification_documents');
    expect(dataSource.query.mock.calls[0][0]).toContain('customer_verification_documents');
  });
});
