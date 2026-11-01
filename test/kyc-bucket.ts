import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';
import { resolve } from 'path';

const runtimeRequire = createRequire(resolve('package.json'));

/**
 * Stand-in for the private KYC bucket (Supabase Storage is not reachable in
 * e2e). A path exists only once a test put it there, the way a client upload
 * through the signed upload URL would. The ownership check on the path is the
 * real one from KycStorageService.
 */
export const kycBucket = new Set<string>();

/** Marks a fixture document as already uploaded and returns it unchanged. */
export const uploadedKyc = <T extends { storageObjectPath: string }>(doc: T): T => {
  kycBucket.add(doc.storageObjectPath);
  return doc;
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
};

/**
 * Plain property assignment, not vi.spyOn, so a vi.restoreAllMocks() in a
 * suite cannot put the unreachable Supabase client back mid run.
 */
export function installKycBucket(app: INestApplication): void {
  const { KycStorageService } = runtimeRequire('./dist/modules/technician-verifications/kyc-storage.service.js');
  const storage = app.get(KycStorageService);
  const issue = storage.createSignedUploadUrl.bind(storage);
  storage.objectExists = async (path: string, owner: string) => {
    storage.validateObjectPath(path, owner);
    return kycBucket.has(path);
  };
  storage.createSignedUploadUrl = async (owner: string, mimeType: string) => {
    const extension = EXTENSIONS[mimeType];
    if (!extension) return issue(owner, mimeType);
    const storageObjectPath = `kyc/${owner}/${randomUUID()}.${extension}`;
    storage.validateObjectPath(storageObjectPath, owner);
    return {
      storageObjectPath,
      uploadUrl: `https://storage.example.test/upload/${storageObjectPath}?token=e2e`,
      token: 'e2e',
      expiresIn: 7200,
      expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    };
  };
}
