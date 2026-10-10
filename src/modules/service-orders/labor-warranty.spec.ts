import { describe, expect, it, vi } from 'vitest';
import type { EntityManager } from 'typeorm';
import { laborWarrantyDefault, maxLaborWarrantyDays, snapshotLaborWarranty } from './labor-warranty';
import { SystemConfig } from '../system-config/entities/system-config.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { ServiceOrder } from './entities/service-order.entity';

function managerWith(rows: { profile?: object | null; skill?: object | null; config?: Record<string, string> }) {
  const findOneBy = vi.fn(async (entity: unknown, where: { key?: string }) => {
    if (entity === TechnicianProfile) return rows.profile ?? null;
    if (entity === TechnicianSkill) return rows.skill ?? null;
    if (entity === SystemConfig) {
      const value = rows.config?.[where.key ?? ''];
      return value === undefined ? null : { key: where.key, value };
    }
    return null;
  });
  const update = vi.fn();
  return { manager: { findOneBy, update } as unknown as EntityManager, update };
}

describe('labor warranty default (PO 10/10/2026)', () => {
  const profile = { id: 'p1', defaultLaborWarrantyDays: 60 };

  it('takes the per-service value first', async () => {
    const { manager } = managerWith({ profile, skill: { typicalWarrantyDays: 45 } });
    expect(await laborWarrantyDefault(manager, 'u1', 's1')).toBe(45);
  });

  it('falls back to the technician default when the service has none', async () => {
    const { manager } = managerWith({ profile, skill: { typicalWarrantyDays: null } });
    expect(await laborWarrantyDefault(manager, 'u1', 's1')).toBe(60);
  });

  it('keeps an explicit zero rather than falling through', async () => {
    const { manager } = managerWith({ profile, skill: { typicalWarrantyDays: 0 } });
    expect(await laborWarrantyDefault(manager, 'u1', 's1')).toBe(0);
  });

  it('uses warranty.default_days when the technician set nothing, 30 when that is missing', async () => {
    const none = { id: 'p1', defaultLaborWarrantyDays: null };
    expect(await laborWarrantyDefault(managerWith({ profile: none, config: { 'warranty.default_days': '14' } }).manager, 'u1', 's1')).toBe(14);
    expect(await laborWarrantyDefault(managerWith({ profile: none }).manager, 'u1', 's1')).toBe(30);
    expect(await laborWarrantyDefault(managerWith({ profile: null }).manager, 'u1', 's1')).toBe(30);
  });

  it('caps at warranty.max_days', async () => {
    const { manager } = managerWith({ profile, skill: { typicalWarrantyDays: 900 }, config: { 'warranty.max_days': '180' } });
    expect(await maxLaborWarrantyDays(manager)).toBe(180);
    expect(await laborWarrantyDefault(manager, 'u1', 's1')).toBe(180);
  });

  it('ignores a broken config value', async () => {
    const { manager } = managerWith({ profile: null, config: { 'warranty.default_days': 'abc', 'warranty.max_days': '-5' } });
    expect(await maxLaborWarrantyDays(manager)).toBe(365);
    expect(await laborWarrantyDefault(manager, 'u1', 's1')).toBe(30);
  });

  it('writes the resolved days onto the order', async () => {
    const { manager, update } = managerWith({ profile, skill: null });
    await snapshotLaborWarranty(manager, 'o1', 'u1', 's1');
    expect(update).toHaveBeenCalledWith(ServiceOrder, 'o1', { laborWarrantyDays: 60 });
  });
});
