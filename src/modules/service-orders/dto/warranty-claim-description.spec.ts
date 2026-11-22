import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateWarrantyClaimDto } from './warranty-claim.dto';

const errorsFor = (description: unknown) =>
  validateSync(plainToInstance(CreateWarrantyClaimDto, {
    warrantyCoverageId: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', description,
  })).filter(e => e.property === 'description');

describe('CreateWarrantyClaimDto description', () => {
  it('rejects a description made only of emoji or symbols', () => {
    expect(errorsFor('😀😀😀😀😀😀😀😀😀😀')).toHaveLength(1);
    expect(errorsFor('!!!!!!!!!!??')).toHaveLength(1);
    expect(errorsFor('🔥🔥🔥 ★★★ ♥♥♥ 🔥')).toHaveLength(1);
  });
  it('rejects invisible characters', () => {
    expect(errorsFor('Máy kêu to​ quá mức')).toHaveLength(1);
  });
  it('accepts Vietnamese text, with or without emoji', () => {
    expect(errorsFor('Máy lạnh lại chảy nước')).toHaveLength(0);
    expect(errorsFor('Máy lạnh lại chảy nước 😢')).toHaveLength(0);
    expect(errorsFor('Lỗi E4 sau 2 ngày')).toHaveLength(0);
  });
  it('keeps the 10 to 2000 character bounds', () => {
    expect(errorsFor('ngắn')).toHaveLength(1);
    expect(errorsFor('a'.repeat(2001))).toHaveLength(1);
  });
});
