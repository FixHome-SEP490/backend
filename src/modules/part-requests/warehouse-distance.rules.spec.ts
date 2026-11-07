import { describe, expect, it } from 'vitest';
import { nearestEligible, straightLineKm } from './warehouse-distance.rules';

describe('warehouse nearest-distance ranking', () => {
  const warehouses = [
    { id: 'warehouse-a', latitude: '10.77', longitude: '106.69' },
    { id: 'warehouse-b', latitude: '10.80', longitude: '106.73' },
    { id: 'warehouse-c', latitude: null, longitude: null },
  ];

  it('selects geographically closest eligible warehouse, not first ID', () => {
    expect(nearestEligible(warehouses, { latitude: 10.801, longitude: 106.731 })?.id).toBe('warehouse-b');
  });

  it('falls back to existing ID order when technician or all warehouse coordinates missing', () => {
    expect(nearestEligible(warehouses, null)?.id).toBe('warehouse-a');
    expect(nearestEligible(warehouses, { latitude: 120, longitude: 106 })?.id).toBe('warehouse-a');
    expect(nearestEligible([warehouses[2]], { latitude: 10.77, longitude: 106.7 })?.id).toBe('warehouse-c');
  });

  it('ranks only eligible candidates and uses ID as a tie breaker', () => {
    expect(nearestEligible([warehouses[0], warehouses[2]], { latitude: 10.80, longitude: 106.73 })?.id).toBe('warehouse-a');
    expect(nearestEligible([warehouses[1], warehouses[0]], { latitude: 10.77, longitude: 106.69 })?.id).toBe('warehouse-a');
    expect(nearestEligible([
      { id: 'b', latitude: 10.78, longitude: 106.7 },
      { id: 'a', latitude: 10.78, longitude: 106.7 },
    ], { latitude: 10.78, longitude: 106.7 })?.id).toBe('a');
  });

  it('uses great-circle distance, not degrees or an artificial stock score', () => {
    const km = straightLineKm({ latitude: 10.77, longitude: 106.69 }, { latitude: 10.78, longitude: 106.69 });
    expect(km).not.toBeNull();
    expect(km!).toBeGreaterThan(1);
    expect(km!).toBeLessThan(1.2);
    expect(straightLineKm({ latitude: null, longitude: 0 }, { latitude: 0, longitude: 0 })).toBeNull();
  });
});
