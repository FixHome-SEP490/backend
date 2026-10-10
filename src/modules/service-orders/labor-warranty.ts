import { EntityManager } from 'typeorm';
import { SystemConfig } from '../system-config/entities/system-config.entity';
import { TechnicianProfile } from '../technicians/entities/technician-profile.entity';
import { TechnicianSkill } from '../technicians/entities/technician-skill.entity';
import { ServiceOrder } from './entities/service-order.entity';

const configInt = async (manager: EntityManager, key: string, fallback: number) => {
  const row = await manager.findOneBy(SystemConfig, { key });
  const value = row ? Number(row.value) : NaN;
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

/** The longest labor warranty a technician may give (config `warranty.max_days`, 365 by default). */
export const maxLaborWarrantyDays = (manager: EntityManager) => configInt(manager, 'warranty.max_days', 365);

/**
 * A technician's labor warranty for a service (PO 10/10/2026): what they set on that service,
 * else their profile default, else `warranty.default_days` (30); never above `warranty.max_days`.
 * A reference only: the binding value is the one snapshotted on the approved quotation or order.
 */
export async function laborWarrantyDefault(manager: EntityManager, technicianUserId: string, serviceId: string): Promise<number> {
  const profile = await manager.findOneBy(TechnicianProfile, { userId: technicianUserId });
  const skill = profile ? await manager.findOneBy(TechnicianSkill, { technicianId: profile.id, serviceId }) : null;
  const own = skill?.typicalWarrantyDays ?? profile?.defaultLaborWarrantyDays ?? null;
  const days = own != null && Number.isFinite(Number(own)) ? Number(own) : await configInt(manager, 'warranty.default_days', 30);
  return Math.max(0, Math.min(Math.floor(days), await maxLaborWarrantyDays(manager)));
}

/** Fixes the order's labor warranty from the technician now assigned to it. */
export async function snapshotLaborWarranty(manager: EntityManager, orderId: string, technicianUserId: string, serviceId: string): Promise<void> {
  const laborWarrantyDays = await laborWarrantyDefault(manager, technicianUserId, serviceId);
  await manager.update(ServiceOrder, orderId, { laborWarrantyDays });
}
