import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';

/**
 * A comma-separated list of ids in a query string (`?orderIds=a,b,c`), as one page of a list sends it.
 * Each id must be a UUID, duplicates are dropped, and at most `max` ids are taken so a read stays one page.
 */
export function parseIdList(raw: unknown, max = 50): string[] {
  if (typeof raw !== 'string' || !raw.trim()) throw new BadRequestException('Thiếu danh sách mã.');
  const ids = [...new Set(raw.split(',').map(id => id.trim().toLowerCase()).filter(Boolean))];
  if (!ids.length || ids.length > max || ids.some(id => !isUUID(id))) {
    throw new BadRequestException(`Danh sách mã không hợp lệ (tối đa ${max} mã).`);
  }
  return ids;
}
