// src/shared/utils/account-name.ts

/**
 * Bring a person's name to the form banks print on an account: no diacritics,
 * upper case, single spaces. "Nguyễn  Văn Thọ" and "NGUYEN VAN THO" both become
 * "NGUYEN VAN THO".
 *
 * PO decision (29/09/2026): a bank account may only be saved when its holder
 * name matches the KYC name under this comparison. It deliberately treats names
 * that differ only by accents as equal ("Thọ" and "Thô"), because the bank side
 * carries no accents at all and there is nothing finer to compare against.
 */
export function normalizeAccountName(value: string): string {
  return (
    value
      .normalize('NFD')
      // Combining marks carry every Vietnamese tone and vowel accent.
      .replace(/\p{M}/gu, '')
      // "đ" is a letter of its own, not a letter plus a mark, so NFD keeps it.
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toUpperCase()
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function accountNamesMatch(a: string, b: string): boolean {
  const left = normalizeAccountName(a);
  return left.length > 0 && left === normalizeAccountName(b);
}
