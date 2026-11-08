import { beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { FaceMatchService } from './face-match.service';

const send = vi.fn();
vi.mock('@aws-sdk/client-rekognition', () => ({
  RekognitionClient: class { send = send; },
  CompareFacesCommand: class { constructor(public input: unknown) {} },
}));

const config = (v: Record<string, string>) => ({ get: (k: string) => v[k] }) as any;
let jpeg: Buffer;

describe('FaceMatchService', () => {
  beforeEach(async () => {
    send.mockReset();
    jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#888' } }).jpeg().toBuffer();
  });

  it('does not call AWS while disabled', async () => {
    const result = await new FaceMatchService(config({})).compare(jpeg, jpeg);
    expect(result).toEqual({ outcome: 'skipped' });
    expect(send).not.toHaveBeenCalled();
  });

  it('returns the best similarity, rounded', async () => {
    send.mockResolvedValue({ FaceMatches: [{ Similarity: 71.234 }, { Similarity: 99.9631 }] });
    const result = await new FaceMatchService(config({ FACE_MATCH_ENABLED: 'true' })).compare(jpeg, jpeg);
    expect(result).toEqual({ outcome: 'scored', similarity: 99.96 });
    const sent = send.mock.calls[0][0].input;
    expect(Buffer.isBuffer(sent.SourceImage.Bytes)).toBe(true);
    expect(sent.SimilarityThreshold).toBe(0);
  });

  it('reports no face for an empty match list or when AWS finds none in the selfie', async () => {
    const service = new FaceMatchService(config({ FACE_MATCH_ENABLED: 'true' }));
    send.mockResolvedValueOnce({ FaceMatches: [], UnmatchedFaces: [] });
    expect(await service.compare(jpeg, jpeg)).toEqual({ outcome: 'no_face' });
    send.mockRejectedValueOnce(Object.assign(new Error('no faces'), { name: 'InvalidParameterException' }));
    expect(await service.compare(jpeg, jpeg)).toEqual({ outcome: 'no_face' });
  });

  it('fails open when AWS is throttled or unreachable', async () => {
    send.mockRejectedValue(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    const result = await new FaceMatchService(config({ FACE_MATCH_ENABLED: 'true' })).compare(jpeg, jpeg);
    expect(result).toEqual({ outcome: 'skipped' });
  });

  it('reads the threshold from config, default 80', () => {
    expect(new FaceMatchService(config({})).threshold).toBe(80);
    expect(new FaceMatchService(config({ FACE_MATCH_THRESHOLD: '90' })).threshold).toBe(90);
  });
});
