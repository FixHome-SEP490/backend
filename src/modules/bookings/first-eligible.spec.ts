import { describe, expect, it } from 'vitest';
import { firstEligible } from './first-eligible';

describe('firstEligible (candidate list, checked in batches)', () => {
  it('keeps the ranking order whatever order the checks finish in', async () => {
    const slow = (n: number) => new Promise<boolean>((resolve) => setTimeout(() => resolve(n % 2 === 0), 10 - n));
    expect(await firstEligible([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], slow, 20, 4)).toEqual([0, 2, 4, 6, 8]);
  });

  it('stops at the limit and checks no further batch than needed', async () => {
    const checked: number[] = [];
    const ok = async (n: number) => { checked.push(n); return true; };
    expect(await firstEligible(Array.from({ length: 50 }, (_, i) => i), ok, 5, 4)).toEqual([0, 1, 2, 3, 4]);
    expect(checked).toHaveLength(8);
  });

  it('runs a whole batch at once', async () => {
    let running = 0;
    let peak = 0;
    const check = async () => { running++; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 5)); running--; return false; };
    await firstEligible(Array.from({ length: 16 }, (_, i) => i), check, 20, 8);
    expect(peak).toBe(8);
  });
});
