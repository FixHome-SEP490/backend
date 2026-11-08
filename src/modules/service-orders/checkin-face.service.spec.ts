import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckinFaceService } from './checkin-face.service';

const ORDER = 'order-1';
const USER = 'user-1';
const buf = Buffer.from('x');

function make(opts: { enabled?: boolean; analyze?: any[]; compare?: any[]; doc?: any } = {}) {
  const analyze = vi.fn();
  for (const a of opts.analyze ?? []) analyze.mockResolvedValueOnce(a);
  const compare = vi.fn();
  for (const c of opts.compare ?? []) compare.mockResolvedValueOnce(c);
  const faceMatch = { enabled: opts.enabled ?? true, threshold: 80, analyze, compare } as any;
  const qb: any = { innerJoin: () => qb, where: () => qb, andWhere: () => qb, orderBy: () => qb, getOne: async () => opts.doc ?? null };
  const kyc = { download: vi.fn().mockResolvedValue(buf) } as any;
  const config = { get: (k: string) => ({ JWT_ACCESS_SECRET: 's3cret', FACE_CHECKIN_ENFORCE: 'true' } as any)[k] } as any;
  const service = new CheckinFaceService(config, faceMatch, kyc, { createQueryBuilder: () => qb } as any);
  return { service, analyze, compare, kyc };
}
const face = (yaw: number, smiling = false, count = 1) => ({ outcome: 'faces', count, yaw, smiling });
/** A token the service itself issued, forced to a given challenge. */
function tokenFor(service: CheckinFaceService, challenge: 'turn_head' | 'smile') {
  for (let i = 0; i < 200; i++) {
    const t = service.issueChallenge(ORDER, USER);
    if (t.challenge === challenge) return t.token;
  }
  throw new Error('challenge not produced');
}

describe('CheckinFaceService', () => {
  it('issues no challenge while face checks are off', () => {
    expect(make({ enabled: false }).service.issueChallenge(ORDER, USER)).toEqual({ challenge: null });
  });

  it('issues no challenge when there is no signing secret (an empty key would be forgeable)', () => {
    const { service } = make({});
    (service as any).config = { get: () => undefined };
    expect(service.issueChallenge(ORDER, USER)).toEqual({ challenge: null });
  });

  it('rejects a token for another order, another technician, a forged one or an expired one', async () => {
    const { service } = make({});
    const token = tokenFor(service, 'smile')!;
    const call = (over: object) => service.verify({ orderId: ORDER, userId: USER, token, plain: buf, challengePhoto: buf, ...over });
    await expect(call({ orderId: 'other' })).rejects.toThrow(/hết hạn/);
    await expect(call({ userId: 'other' })).rejects.toThrow(/hết hạn/);
    await expect(call({ token: token.slice(0, -2) + 'AA' })).rejects.toThrow(/hết hạn/);
    await expect(call({ challengePhoto: undefined })).rejects.toThrow(/hết hạn/);
    service.now = () => Date.now() + 6 * 60 * 1000;
    await expect(call({})).rejects.toThrow(/hết hạn/);
  });

  it('passes a smile challenge and writes the match on the evidence', async () => {
    const { service } = make({
      analyze: [face(0, false), face(0, true)],
      compare: [{ outcome: 'scored', similarity: 97 }, { outcome: 'scored', similarity: 96.5 }],
      doc: { storageObjectPath: 'kyc/u/face.jpg' },
    });
    const note = await service.verify({ orderId: ORDER, userId: USER, token: tokenFor(service, 'smile'), plain: buf, challengePhoto: buf });
    expect(note).toContain('Liveness đạt');
    expect(note).toContain('96.5%');
  });

  it('refuses a smile challenge when the second photo does not smile', async () => {
    const { service } = make({ analyze: [face(0, false), face(0, false)] });
    await expect(service.verify({ orderId: ORDER, userId: USER, token: tokenFor(service, 'smile'), plain: buf, challengePhoto: buf }))
      .rejects.toThrow(/chưa thấy bạn cười/);
  });

  it('refuses a head-turn challenge when the head did not turn, or the first photo is already turned', async () => {
    const a = make({ analyze: [face(2), face(8)] });
    await expect(a.service.verify({ orderId: ORDER, userId: USER, token: tokenFor(a.service, 'turn_head'), plain: buf, challengePhoto: buf }))
      .rejects.toThrow(/chưa quay đầu/);
    const b = make({ analyze: [face(30), face(35)] });
    await expect(b.service.verify({ orderId: ORDER, userId: USER, token: tokenFor(b.service, 'turn_head'), plain: buf, challengePhoto: buf }))
      .rejects.toThrow(/nhìn thẳng/);
  });

  it('accepts a head turn to either side', async () => {
    for (const yaw of [-28, 28]) {
      const { service } = make({ analyze: [face(3), face(yaw)], compare: [{ outcome: 'scored', similarity: 95 }] });
      await expect(service.verify({ orderId: ORDER, userId: USER, token: tokenFor(service, 'turn_head'), plain: buf, challengePhoto: buf }))
        .resolves.toContain('Liveness đạt');
    }
  });

  it('refuses no face, several faces, or two photos of different people', async () => {
    const none = make({ analyze: [{ outcome: 'no_face' }, face(0)] });
    await expect(none.service.verify({ orderId: ORDER, userId: USER, token: tokenFor(none.service, 'smile'), plain: buf, challengePhoto: buf })).rejects.toThrow(/Không thấy khuôn mặt/);
    const many = make({ analyze: [face(0, false, 2), face(0, true)] });
    await expect(many.service.verify({ orderId: ORDER, userId: USER, token: tokenFor(many.service, 'smile'), plain: buf, challengePhoto: buf })).rejects.toThrow(/nhiều hơn một/);
    const other = make({ analyze: [face(0), face(0, true)], compare: [{ outcome: 'scored', similarity: 30 }] });
    await expect(other.service.verify({ orderId: ORDER, userId: USER, token: tokenFor(other.service, 'smile'), plain: buf, challengePhoto: buf })).rejects.toThrow(/không giống cùng một người/);
  });

  it('does not block a weak match with the registered face, it flags it for admin', async () => {
    const { service } = make({
      analyze: [face(0), face(0, true)],
      compare: [{ outcome: 'scored', similarity: 95 }, { outcome: 'scored', similarity: 55 }],
      doc: { storageObjectPath: 'kyc/u/face.jpg' },
    });
    const note = await service.verify({ orderId: ORDER, userId: USER, token: tokenFor(service, 'smile'), plain: buf, challengePhoto: buf });
    expect(note).toContain('CẦN KIỂM TRA');
    expect(note).toContain('55%');
  });

  it('fails open when Rekognition is unreachable', async () => {
    const { service } = make({ analyze: [{ outcome: 'skipped' }, { outcome: 'skipped' }] });
    await expect(service.verify({ orderId: ORDER, userId: USER, token: tokenFor(service, 'smile'), plain: buf, challengePhoto: buf }))
      .resolves.toContain('Chưa kiểm tra được liveness');
  });

  it('refuses the old single-photo upload only when enforced and enabled', () => {
    expect(make({}).service.enforced).toBe(true);
    expect(make({ enabled: false }).service.enforced).toBe(false);
  });
});
