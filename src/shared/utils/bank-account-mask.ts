/**
 * Bank account numbers leave the server as their last four digits only, as
 * the bank account audit already does. Payouts read the full number from the
 * database, so no screen needs it.
 */
export function maskAccountNumber(accountNumber: string | null | undefined): string | null {
  if (!accountNumber) return accountNumber ?? null;
  const digits = accountNumber.replace(/\s+/g, '');
  return digits.length <= 4 ? digits : `••••${digits.slice(-4)}`;
}

/**
 * Masks "STK 0123456789" inside a stored description. Wallet transactions are
 * immutable, so older rows that carry the full number are masked on the way
 * out rather than rewritten.
 */
export function maskAccountNumbersInText(text: string | null | undefined): string | null {
  if (!text) return text ?? null;
  return text.replace(/(STK\s*)(\d{5,19})/gi, (_match, label: string, digits: string) => `${label}${maskAccountNumber(digits)}`);
}
