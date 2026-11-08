// src/modules/service-orders/checkin-face.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { createHmac, randomInt, timingSafeEqual } from 'crypto';
import { Repository } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { FaceMatchService } from '../face-match/face-match.service';
import { KycStorageService } from '../technician-verifications/kyc-storage.service';
import { VerificationDocument } from '../technician-verifications/entities/verification-document.entity';
import { DocumentType } from '../../shared/enums';

export type FaceChallenge = 'turn_head' | 'smile';
const CHALLENGES: FaceChallenge[] = ['turn_head', 'smile'];
const TTL_MS = 5 * 60 * 1000;
/** The challenge photo must turn at least this far; the plain photo must stay below the lower bound. */
const TURN_MIN_DEG = 20;
const FRONT_MAX_DEG = 15;

/**
 * Light liveness for the check-in face (PO 09/11/2026): the technician takes a plain photo and then one
 * photo doing a random challenge asked by the server (turn the head or smile). A photographed photo cannot
 * follow a challenge it has not seen. Not a substitute for video liveness: a replayed video can still pass.
 * A weak match with the registered face does not block (bad light happens); it is written on the evidence for admin.
 */
@Injectable()
export class CheckinFaceService {
  constructor(
    private readonly config: ConfigService,
    private readonly faceMatch: FaceMatchService,
    private readonly kyc: KycStorageService,
    @InjectRepository(VerificationDocument) private readonly documents: Repository<VerificationDocument>,
  ) {}

  /** Replaceable in tests. */
  now: () => number = Date.now;

  /** App sends the challenge flow only when this is on; off => the old single photo upload keeps working. */
  get enabled(): boolean {
    return this.faceMatch.enabled;
  }

  /** The old single-photo upload is refused only once the app that sends challenges is out (env FACE_CHECKIN_ENFORCE). */
  get enforced(): boolean {
    return this.enabled && this.config.get<string>('FACE_CHECKIN_ENFORCE') === 'true';
  }

  issueChallenge(orderId: string, userId: string): { challenge: FaceChallenge | null; token?: string; expiresAt?: string } {
    if (!this.enabled || !this.secret()) return { challenge: null };
    const challenge = CHALLENGES[randomInt(CHALLENGES.length)];
    const exp = this.now() + TTL_MS;
    return { challenge, token: this.sign(orderId, userId, challenge, exp), expiresAt: new Date(exp).toISOString() };
  }

  /** Returns the note to store on the evidence; throws a retryable validation error when the challenge fails. */
  async verify(input: { orderId: string; userId: string; token?: string; plain: Buffer; challengePhoto?: Buffer }): Promise<string | undefined> {
    if (!this.enabled) return undefined;
    if (!this.secret()) throw this.fail('Chưa cấu hình khóa ký phiên xác minh khuôn mặt.');
    const challenge = this.readToken(input.orderId, input.userId, input.token);
    if (!challenge || !input.challengePhoto) throw this.fail('Phiên xác minh khuôn mặt đã hết hạn hoặc thiếu ảnh thứ hai. Vui lòng chụp lại.');

    const [plain, moved] = await Promise.all([this.faceMatch.analyze(input.plain), this.faceMatch.analyze(input.challengePhoto)]);
    if (plain.outcome === 'skipped' || moved.outcome === 'skipped') return 'Chưa kiểm tra được liveness (dịch vụ nhận diện tạm không khả dụng).';
    if (plain.outcome === 'no_face' || moved.outcome === 'no_face') throw this.fail('Không thấy khuôn mặt trong ảnh. Vui lòng chụp lại rõ mặt, đủ sáng.');
    if (plain.count > 1 || moved.count > 1) throw this.fail('Trong ảnh có nhiều hơn một khuôn mặt. Vui lòng chụp lại chỉ một mình bạn.');

    if (challenge === 'turn_head') {
      if (Math.abs(plain.yaw) >= FRONT_MAX_DEG) throw this.fail('Ảnh thứ nhất cần nhìn thẳng vào camera. Vui lòng chụp lại.');
      if (Math.abs(moved.yaw) < TURN_MIN_DEG) throw this.fail('Ảnh thứ hai chưa quay đầu đủ. Hãy quay mặt sang một bên rồi chụp lại.');
    } else {
      if (plain.smiling) throw this.fail('Ảnh thứ nhất cần giữ mặt bình thường, không cười. Vui lòng chụp lại.');
      if (!moved.smiling) throw this.fail('Ảnh thứ hai chưa thấy bạn cười. Hãy mỉm cười rồi chụp lại.');
    }

    const same = await this.faceMatch.compare(input.plain, input.challengePhoto);
    if (same.outcome === 'scored' && same.similarity < this.faceMatch.threshold) {
      throw this.fail('Hai ảnh không giống cùng một người. Vui lòng chụp lại.');
    }

    return this.matchRegistered(input.userId, input.plain);
  }

  private async matchRegistered(userId: string, plain: Buffer): Promise<string> {
    const doc = await this.documents
      .createQueryBuilder('d')
      .innerJoin('d.verification', 'v')
      .where('v.technician_id = :userId', { userId })
      .andWhere('d.document_type = :type', { type: DocumentType.FACE_PHOTO })
      .andWhere('d.storage_object_path IS NOT NULL')
      .orderBy('d.created_at', 'DESC')
      .getOne();
    if (!doc?.storageObjectPath) return 'Liveness đạt. Chưa có ảnh đăng ký để đối chiếu.';
    let registered: Buffer;
    try {
      registered = await this.kyc.download(doc.storageObjectPath, userId);
    } catch {
      return 'Liveness đạt. Chưa đọc được ảnh đăng ký để đối chiếu.';
    }
    const result = await this.faceMatch.compare(plain, registered);
    if (result.outcome !== 'scored') return 'Liveness đạt. Chưa đối chiếu được với ảnh đăng ký.';
    return result.similarity >= this.faceMatch.threshold
      ? `Liveness đạt. Khớp ảnh đăng ký ${result.similarity}%.`
      : `CẦN KIỂM TRA: khuôn mặt chỉ khớp ảnh đăng ký ${result.similarity}% (ngưỡng ${this.faceMatch.threshold}%).`;
  }

  private fail(message: string): BusinessException {
    return new BusinessException(ErrorCodes.VALIDATION_FAILED, message);
  }

  /** The server's JWT signing secret; without one nothing is signed (no challenge is issued). */
  private secret(): string {
    return this.config.get<string>('JWT_ACCESS_SECRET') || this.config.get<string>('JWT_SECRET') || '';
  }

  private sign(orderId: string, userId: string, challenge: FaceChallenge, exp: number): string {
    const body = `${orderId}.${userId}.${challenge}.${exp}`;
    return `${Buffer.from(body).toString('base64url')}.${createHmac('sha256', this.secret()).update(body).digest('base64url')}`;
  }

  /** The challenge in a token that is genuine, for this order and technician, and not expired; else null. */
  private readToken(orderId: string, userId: string, token?: string): FaceChallenge | null {
    const [b64, mac] = (token ?? '').split('.');
    if (!b64 || !mac) return null;
    const body = Buffer.from(b64, 'base64url').toString();
    const expected = createHmac('sha256', this.secret()).update(body).digest('base64url');
    if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
    const [o, u, challenge, exp] = body.split('.');
    if (o !== orderId || u !== userId || Number(exp) < this.now()) return null;
    return (CHALLENGES as string[]).includes(challenge) ? (challenge as FaceChallenge) : null;
  }
}
