// src/modules/face-match/face-match.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CompareFacesCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import sharp from 'sharp';

export type FaceMatchResult =
  | { outcome: 'skipped' }
  | { outcome: 'no_face' }
  | { outcome: 'scored'; similarity: number };

/** Rekognition caps an inline image at 5 MB and reads only JPEG/PNG; a 1600 px JPEG is far under it. */
const MAX_SIDE = 1600;

/**
 * Compares two faces with Amazon Rekognition `CompareFaces`. Images are sent as bytes and never
 * stored by AWS. Disabled or unreachable provider => `skipped`, so manual review still decides.
 */
@Injectable()
export class FaceMatchService {
  private readonly logger = new Logger(FaceMatchService.name);
  private client?: RekognitionClient;

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.config.get<string>('FACE_MATCH_ENABLED') === 'true';
  }

  get threshold(): number {
    return Number(this.config.get('FACE_MATCH_THRESHOLD') ?? 80);
  }

  /** `face` is the live selfie (must hold exactly the face to match); `idCard` may hold other content. */
  async compare(face: Buffer, idCard: Buffer): Promise<FaceMatchResult> {
    if (!this.enabled) return { outcome: 'skipped' };
    try {
      const [source, target] = await Promise.all([this.prepare(face), this.prepare(idCard)]);
      this.client ??= new RekognitionClient({
        region: this.config.get<string>('AWS_REGION') || 'ap-southeast-1',
      });
      const res = await this.client.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: source },
          TargetImage: { Bytes: target },
          SimilarityThreshold: 0,
        }),
      );
      const best = Math.max(0, ...(res.FaceMatches ?? []).map((m) => m.Similarity ?? 0));
      return best > 0 ? { outcome: 'scored', similarity: Math.round(best * 100) / 100 } : { outcome: 'no_face' };
    } catch (error) {
      // Rekognition answers "no face in the source image" with InvalidParameterException.
      if ((error as { name?: string }).name === 'InvalidParameterException') return { outcome: 'no_face' };
      this.logger.warn(`Face match unavailable: ${(error as { name?: string }).name ?? 'unknown error'}`);
      return { outcome: 'skipped' };
    }
  }

  private prepare(input: Buffer): Promise<Buffer> {
    return sharp(input)
      .rotate()
      .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
  }
}
