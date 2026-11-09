import { describe, expect, it, vi } from 'vitest';
import { CheckinFaceService, type FaceChallenge } from './checkin-face.service';

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
const face = (yaw: number, pitch = 0, count = 1) => ({ outcome: 'faces', count, yaw, pitch });
/** A token the service itself issued, forced to a given challenge. */
function tokenFor(service: CheckinFaceService, challenge: FaceChallenge) {
  for (let i = 0; i < 500; i++) {
    const t = service.issueChallenge(ORDER, USER);
    if (t.challenge === challenge) return t.token;
  }
  throw new Error('challenge not produced');
}
const verify = (m: ReturnType<typeof make>, challenge: FaceChallenge) =>
  m.service.verify({ orderId: ORDER, userId: USER, token: tokenFor(m.service, challenge), plain: buf, challengePhoto: buf });

describe('CheckinFaceService', () => {
  it('issues no challenge while face checks are off', () => {
    expect(make({ enabled: false }).service.issueChallenge(ORDER, USER)).toEqual({ challenge: null });
  });

  it('issues no challenge when there is no signing secret (an empty key would be forgeable)', () => {
    const { service } = make({});
    (service as any).config = { get: () => undefined };
    expect(service.issueChallenge(ORDER, USER)).toEqual({ challenge: null });
  });

  it('only asks for a head movement: left, right, up or down', () => {
    const { service } = make({});
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(service.issueChallenge(ORDER, USER).challenge as string);
    expect([...seen].sort()).toEqual(['look_down', 'look_up', 'turn_left', 'turn_right']);
  });

  it('rejects a token for another order, another technician, a forged one or an expired one', async () => {
    const { service } = make({});
    const token = tokenFor(service, 'turn_left')!;
    const call = (over: object) => service.verify({ orderId: ORDER, userId: USER, token, plain: buf, challengePhoto: buf, ...over });
    await expect(call({ orderId: 'other' })).rejects.toThrow(/hết hạn/);
    await expect(call({ userId: 'other' })).rejects.toThrow(/hết hạn/);
    await expect(call({ token: token.slice(0, -2) + 'AA' })).rejects.toThrow(/hết hạn/);
    await expect(call({ challengePhoto: undefined })).rejects.toThrow(/hết hạn/);
    service.now = () => Date.now() + 6 * 60 * 1000;
    await expect(call({})).rejects.toThrow(/hết hạn/);
  });

  it('passes a left or right turn on either sign of the angle, and writes the match on the evidence', async () => {
    for (const [challenge, yaw] of [['turn_left', -30], ['turn_left', 30], ['turn_right', 28], ['turn_right', -28]] as const) {
      const m = make({
        analyze: [face(2), face(yaw)],
        compare: [{ outcome: 'scored', similarity: 97 }, { outcome: 'scored', similarity: 96.5 }],
        doc: { storageObjectPath: 'kyc/u/face.jpg' },
      });
      const note = await verify(m, challenge);
      expect(note).toContain('Liveness đạt');
      expect(note).toContain('96.5%');
    }
  });

  it('passes looking up or down', async () => {
    for (const [challenge, pitch] of [['look_up', 25], ['look_down', -22]] as const) {
      const m = make({ analyze: [face(0, 3), face(1, pitch)], compare: [{ outcome: 'scored', similarity: 95 }] });
      await expect(verify(m, challenge)).resolves.toContain('Liveness đạt');
    }
  });

  it('refuses a movement that is too small, or on the wrong axis', async () => {
    await expect(verify(make({ analyze: [face(2), face(9)] }), 'turn_right')).rejects.toThrow(/chưa quay mặt sang phải đủ/);
    await expect(verify(make({ analyze: [face(0, 2), face(0, 8)] }), 'look_up')).rejects.toThrow(/chưa ngẩng mặt lên đủ/);
    // asked to look up, the head turned sideways instead
    await expect(verify(make({ analyze: [face(0, 0), face(30, 16)] }), 'look_up')).rejects.toThrow(/chưa đúng hướng/);
  });

  it('refuses a first photo that is not looking straight', async () => {
    await expect(verify(make({ analyze: [face(35), face(60)] }), 'turn_left')).rejects.toThrow(/nhìn thẳng/);
    await expect(verify(make({ analyze: [face(0, 30), face(0, 55)] }), 'look_up')).rejects.toThrow(/nhìn thẳng/);
  });

  it('refuses no face, several faces, or two photos of different people', async () => {
    await expect(verify(make({ analyze: [{ outcome: 'no_face' }, face(30)] }), 'turn_left')).rejects.toThrow(/Không thấy khuôn mặt/);
    await expect(verify(make({ analyze: [face(0, 0, 2), face(30)] }), 'turn_left')).rejects.toThrow(/nhiều hơn một/);
    await expect(verify(make({ analyze: [face(0), face(30)], compare: [{ outcome: 'scored', similarity: 30 }] }), 'turn_left'))
      .rejects.toThrow(/không giống cùng một người/);
  });

  it('does not block a weak match with the registered face, it flags it for admin', async () => {
    const m = make({
      analyze: [face(0), face(30)],
      compare: [{ outcome: 'scored', similarity: 95 }, { outcome: 'scored', similarity: 55 }],
      doc: { storageObjectPath: 'kyc/u/face.jpg' },
    });
    const note = await verify(m, 'turn_left');
    expect(note).toContain('CẦN KIỂM TRA');
    expect(note).toContain('55%');
  });

  it('fails open when Rekognition is unreachable', async () => {
    const m = make({ analyze: [{ outcome: 'skipped' }, { outcome: 'skipped' }] });
    await expect(verify(m, 'turn_left')).resolves.toContain('Chưa kiểm tra được liveness');
  });

  it('refuses the old single-photo upload only when enforced and enabled', () => {
    expect(make({}).service.enforced).toBe(true);
    expect(make({ enabled: false }).service.enforced).toBe(false);
  });
});
