import { describe, expect, it } from 'vitest';
import { accountNamesMatch, normalizeAccountName } from './account-name';

describe('normalizeAccountName', () => {
  it.each([
    ['Nguyễn Văn Thọ', 'NGUYEN VAN THO'],
    ['Đặng Thị Đào', 'DANG THI DAO'],
    ['đỗ đức đạt', 'DO DUC DAT'],
    ['  Trần   Văn   A  ', 'TRAN VAN A'],
    ['NGUYEN VAN THO', 'NGUYEN VAN THO'],
    // Precomposed and decomposed forms of the same letter must meet.
    ['Nguyễn', 'NGUYEN'],
    ['Ưng Hoàng Phúc', 'UNG HOANG PHUC'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeAccountName(input)).toBe(expected);
  });
});

describe('accountNamesMatch', () => {
  it('matches the KYC name against the bank form of the same name', () => {
    expect(accountNamesMatch('NGUYEN VAN THO', 'Nguyễn Văn Thọ')).toBe(true);
  });

  it('ignores case and spacing', () => {
    expect(accountNamesMatch('nguyen  van   tho', 'Nguyễn Văn Thọ')).toBe(true);
  });

  it('treats names differing only by accents as the same, as the PO accepted', () => {
    // The bank side carries no accents, so nothing finer can be compared.
    expect(accountNamesMatch('Nguyên Văn Thô', 'Nguyễn Văn Thọ')).toBe(true);
  });

  it('rejects a different person', () => {
    expect(accountNamesMatch('TRAN VAN THO', 'Nguyễn Văn Thọ')).toBe(false);
  });

  it('rejects a name with a word missing', () => {
    expect(accountNamesMatch('NGUYEN THO', 'Nguyễn Văn Thọ')).toBe(false);
  });

  it('rejects the same words in a different order', () => {
    expect(accountNamesMatch('THO VAN NGUYEN', 'Nguyễn Văn Thọ')).toBe(false);
  });

  it('never matches two empty names', () => {
    expect(accountNamesMatch('', '')).toBe(false);
    expect(accountNamesMatch('   ', '  ')).toBe(false);
  });
});
