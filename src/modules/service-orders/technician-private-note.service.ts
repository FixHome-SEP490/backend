import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/** TECH 42: an empty note clears it. Plain text, at most 2.000 characters. */
export class TechnicianPrivateNoteDto {
  @ApiProperty({ maxLength: 2000, description: 'Private note; empty clears it' })
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/\u0000/g, '').trim() : value))
  @IsString() @MaxLength(2000)
  note: string;
}

/**
 * The technician's own note on an order, kept on their latest assignment row of that order.
 * A technician who never held the order gets 404, so the endpoint reveals nothing.
 */
@Injectable()
export class TechnicianPrivateNoteService {
  constructor(private readonly dataSource: DataSource) {}

  async read(orderId: string, technicianId: string): Promise<{ note: string; updatedAt: string | null }> {
    const [row] = await this.dataSource.query(
      `SELECT private_note, updated_at FROM technician_assignments
        WHERE service_order_id = $1 AND technician_id = $2 ORDER BY assigned_at DESC LIMIT 1`,
      [orderId, technicianId],
    );
    if (!row) throw new NotFoundException('Không tìm thấy đơn.');
    return { note: row.private_note ?? '', updatedAt: row.private_note ? new Date(row.updated_at).toISOString() : null };
  }

  async write(orderId: string, technicianId: string, note: string): Promise<{ note: string; updatedAt: string | null }> {
    const rows = await this.dataSource.query(
      `UPDATE technician_assignments SET private_note = NULLIF($3, ''), updated_at = now()
        WHERE id = (SELECT id FROM technician_assignments WHERE service_order_id = $1 AND technician_id = $2
                    ORDER BY assigned_at DESC LIMIT 1)
        RETURNING private_note, updated_at`,
      [orderId, technicianId, note],
    );
    const row = Array.isArray(rows[0]) ? rows[0][0] : rows[0];
    if (!row) throw new NotFoundException('Không tìm thấy đơn.');
    return { note: row.private_note ?? '', updatedAt: row.private_note ? new Date(row.updated_at).toISOString() : null };
  }
}
