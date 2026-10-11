import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { Transform } from 'class-transformer';
import { VN_FROM, VN_TO, foldVietnamese } from '../../modules/technicians/admin-technicians.service';

/**
 * Text search for list pages (PO 12/10/2026: every table pages on the server, so search must too).
 * Each column is compared without case or Vietnamese accents, so "dieu hoa" finds "Điều hòa".
 */
export function andWhereTextMatches<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  columns: string[],
  search: string | undefined,
): void {
  const folded = foldVietnamese(search?.trim() ?? '');
  if (!folded || !columns.length) return;
  const clauses = columns.map((column) => `translate(lower(COALESCE(${column}, '')), :vnFrom, :vnTo) LIKE :folded ESCAPE '\\'`);
  const escaped = folded.replace(/[\\%_]/g, (ch) => '\\' + ch);
  qb.andWhere(`(${clauses.join(' OR ')})`, { vnFrom: VN_FROM, vnTo: VN_TO, folded: `%${escaped}%` });
}

/** `?statuses=a,b` → ['a', 'b'], so class-validator checks each value. */
export const CsvToArray = () =>
  Transform(({ value }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : value,
  );
