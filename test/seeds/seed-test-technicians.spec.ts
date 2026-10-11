import { describe, expect, it } from 'vitest';
import {
  allocateCategories,
  COUNT,
  LOCATIONS,
  nextSequence,
  missingSequences,
} from '../../src/database/seeds/seed-test-technicians';

describe('append-only technician test seed planning', () => {
  it('preserves tech42 and plans only tech43 through tech100', () => {
    const emails = Array.from(
      { length: 42 },
      (_, index) => `tech${index + 1}@fixhome.vn`,
    );
    const missing = missingSequences(emails, { from: 42, to: 100 });
    expect(missing).toHaveLength(58);
    expect(missing[0]).toBe(43);
    expect(missing.at(-1)).toBe(100);
    expect(missing).not.toContain(42);
  });

  it('fills gaps without replacing existing case-insensitive emails or going outside the range', () => {
    expect(
      missingSequences(
        ['TECH42@fixhome.vn', 'tech44@fixhome.vn', 'tech100@fixhome.vn'],
        { from: 42, to: 45 },
      ),
    ).toEqual([43, 45]);
    expect(
      missingSequences(['tech42@fixhome.vn'], { from: 42, to: 42 }),
    ).toEqual([]);
    for (const range of [
      { from: 0, to: 10 },
      { from: 100, to: 42 },
      { from: 42.5, to: 100 },
      { from: 1, to: 1001 },
      { from: 1, to: 501 },
    ]) {
      expect(() => missingSequences([], range)).toThrow();
    }
  });

  it('balances 58 technicians across the five current service categories', () => {
    const ids = ['kitchen', 'cooling', 'electrical', 'other', 'locks'];
    const allocation = allocateCategories(ids, 58);
    expect(allocation).toHaveLength(58);
    for (const id of ids)
      expect([11, 12]).toContain(
        allocation.filter((value) => value === id).length,
      );
  });
  it('finds the numeric maximum, including case variants and leading zeros', () => {
    expect(
      nextSequence([
        'tech9@fixhome.vn',
        'tech12@fixhome.vn',
        'TECH0031@fixhome.vn',
        'tech99@example.test',
        'tech8x@fixhome.vn',
      ]),
    ).toBe(32);
    expect(nextSequence([])).toBe(1);
  });

  it('rejects sequences that cannot be represented safely', () => {
    expect(() => nextSequence(['tech99999999999999999999@fixhome.vn'])).toThrow(
      'safe integer',
    );
  });

  it('covers all categories and differs by at most one technician per category', () => {
    for (const size of [1, 5, 7, 30]) {
      const categories = Array.from(
        { length: size },
        (_, i) => `database-category-${i}`,
      );
      const allocation = allocateCategories(categories);
      const counts = categories.map(
        (id) => allocation.filter((category) => category === id).length,
      );
      expect(allocation).toHaveLength(COUNT);
      expect(new Set(allocation).size).toBe(size);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
    expect(() => allocateCategories([])).toThrow();
    expect(() =>
      allocateCategories(Array.from({ length: 31 }, (_, i) => String(i))),
    ).toThrow();
  });

  it('provides distinct wards and GPS points inside the urban HCM fixture bounds', () => {
    expect(LOCATIONS).toHaveLength(COUNT);
    expect(new Set(LOCATIONS.map(([ward]) => ward)).size).toBe(COUNT);
    expect(new Set(LOCATIONS.map(([, lat, lng]) => `${lat},${lng}`)).size).toBe(
      COUNT,
    );
    for (const [, lat, lng] of LOCATIONS) {
      expect(lat).toBeGreaterThan(10.7);
      expect(lat).toBeLessThan(10.9);
      expect(lng).toBeGreaterThan(106.6);
      expect(lng).toBeLessThan(106.8);
    }
  });
});
