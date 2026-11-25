// src/modules/technician-skill-verifications/dto/submit-category-evidence.dto.spec.ts
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SubmitCategoryEvidenceDto } from './submit-category-evidence.dto';

const A = '3f1c2c5e-8a47-4d0b-9a55-1d1f6f3b1a01';
const B = '7b9d2a10-5c3e-4f6a-8e21-0c4d9e7f5b02';
const base = { storageObjectPath: 'kyc/u/a.jpg', fileName: 'a.jpg', fileSize: 10, mimeType: 'image/jpeg' };

const problems = async (categoryIds: unknown) =>
  (await validate(plainToInstance(SubmitCategoryEvidenceDto, { ...base, categoryIds }))).map((e) => e.property);

describe('SubmitCategoryEvidenceDto', () => {
  it('accepts one to twelve distinct category ids', async () => {
    expect(await problems([A])).toEqual([]);
    expect(await problems([A, B])).toEqual([]);
  });

  it('refuses an empty list, duplicates, more than twelve, a non-UUID and a missing list', async () => {
    expect(await problems([])).toContain('categoryIds');
    expect(await problems([A, A])).toContain('categoryIds');
    expect(await problems(Array.from({ length: 13 }, (_, i) => `3f1c2c5e-8a47-4d0b-9a55-1d1f6f3b1a${String(i).padStart(2, '0')}`))).toContain('categoryIds');
    expect(await problems(['not-a-uuid'])).toContain('categoryIds');
    expect(await problems(undefined)).toContain('categoryIds');
  });

  it('keeps the evidence checks of the single-service DTO', async () => {
    const errors = await validate(plainToInstance(SubmitCategoryEvidenceDto, { ...base, categoryIds: [A], evidenceType: 'made_up', claimedYears: 99 }));
    expect(errors.map((e) => e.property).sort()).toEqual(['claimedYears', 'evidenceType']);
  });
});
