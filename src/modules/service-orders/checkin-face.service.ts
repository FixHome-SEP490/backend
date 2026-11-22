// src/modules/service-orders/checkin-face.service.ts
import { Injectable, Optional } from '@nestjs/common';
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
import { CheckinFaceOutcome } from './checkin-face-clearance';
import { CheckinFaceReviewService } from './checkin-face-review.service';

/** `review` is set only under the review rule: what to record next to the evidence. */
export type CheckinFaceResult = { note?: string; review?: CheckinFaceOutcome };

export type FaceChallenge = 'turn_left' | 'turn_right' | 'look_up' | 'look_down';
const CHALLENGES: FaceChallenge[] = ['turn_left', 'turn_right', 'look_up', 'look_down'];
const TTL_MS = 5 * 60 * 1000;
const CHALLENGE_VERB: Record<FaceChallenge, string> = {
  turn_left: 'quay mặt sang trái',
  turn_right: 'quay mặt sang phải',
  look_up: 'ngẩng mặt lên',
  look_down: 'cúi mặt xuống',
};
/** The plain photo must look roughly straight; the challenge photo must move at least this far from it on the asked axis. */
const FRONT_MAX_DEG = 20;
const MOVE_MIN_DEG = 15;

/**
 * Light liveness for the check-in face (PO 09/11/2026): the technician takes a plain photo and then one
 * photo doing a random challenge asked by the server (turn left, turn right, look up or look down). A photographed photo cannot
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
    @Optional() private readonly reviews?: CheckinFaceReviewService,
  ) {}

  /** Replaceable in tests. */
  now: () => number = Date.now;

  /** App sends the challenge flow only when this is on; off => the old single photo upload keeps working. */
  get enabled(): boolean {
    return this.faceMatch.enabled;
  }

  /**
   * The old single-photo upload is refused only once the app that sends challenges is out (env FACE_CHECKIN_ENFORCE).
   * The review rule needs the face match, so it closes the old path too.
   */
  get enforced(): boolean {
    return this.enabled && (this.config.get<string>('FACE_CHECKIN_ENFORCE') === 'true' || this.reviewEnabled);
  }

  issueChallenge(orderId: string, userId: string): { challenge: FaceChallenge | null; token?: string; expiresAt?: string } {
    if (!this.enabled || !this.secret()) return { challenge: null };
    const challenge = CHALLENGES[randomInt(CHALLENGES.length)];
    const exp = this.now() + TTL_MS;
    return { challenge, token: this.sign(orderId, userId, challenge, exp), expiresAt: new Date(exp).toISOString() };
  }

  /** Replaces the old rule that a weak match never blocks (env FACE_CHECKIN_REVIEW_ENABLED, PO 20/11/2026). */
  get reviewEnabled(): boolean {
    return this.enabled && this.config.get<string>('FACE_CHECKIN_REVIEW_ENABLED') === 'true';
  }

  /** Scores under this ask the managers at once, even though the technician may still retake. */
  private get alertBelow(): number {
    const value = Number(this.config.get<string>('FACE_CHECKIN_ALERT_BELOW') ?? 60);
    return Number.isFinite(value) ? value : 60;
  }

  /**
   * Returns the note to store on the evidence and, when the review rule is on, what to record for it;
   * throws a retryable validation error when the challenge fails or the face must be retaken.
   */
  async verify(input: { orderId: string; userId: string; token?: string; plain: Buffer; challengePhoto?: Buffer }): Promise<CheckinFaceResult> {
    if (!this.enabled) return {};
    if (!this.secret()) throw this.fail('Chưa cấu hình khóa ký phiên xác minh khuôn mặt.');
    const challenge = this.readToken(input.orderId, input.userId, input.token);
    if (!challenge || !input.challengePhoto) throw this.fail('Phiên xác minh khuôn mặt đã hết hạn hoặc thiếu ảnh thứ hai. Vui lòng chụp lại.');

    const [plain, moved] = await Promise.all([this.faceMatch.analyze(input.plain), this.faceMatch.analyze(input.challengePhoto)]);
    if (plain.outcome === 'skipped' || moved.outcome === 'skipped') {
      return this.passed('Chưa kiểm tra được liveness (dịch vụ nhận diện tạm không khả dụng).', null);
    }
    if (plain.outcome === 'no_face' || moved.outcome === 'no_face') throw this.fail('Không thấy khuôn mặt trong ảnh. Vui lòng chụp lại rõ mặt, đủ sáng.');
    if (plain.count > 1 || moved.count > 1) throw this.fail('Trong ảnh có nhiều hơn một khuôn mặt. Vui lòng chụp lại chỉ một mình bạn.');

    if (Math.abs(plain.yaw) >= FRONT_MAX_DEG || Math.abs(plain.pitch) >= FRONT_MAX_DEG) {
      throw this.fail('Ảnh thứ nhất cần nhìn thẳng vào camera. Vui lòng chụp lại.');
    }
    // The movement is measured against the first photo. Left/right and up/down are judged by how far the head
    // moved on that axis, not by sign: the sign depends on how each phone saves a front camera photo.
    const horizontal = challenge === 'turn_left' || challenge === 'turn_right';
    const moveDeg = Math.abs(horizontal ? moved.yaw - plain.yaw : moved.pitch - plain.pitch);
    if (moveDeg < MOVE_MIN_DEG) throw this.fail(`Ảnh thứ hai chưa ${CHALLENGE_VERB[challenge]} đủ. Hãy ${CHALLENGE_VERB[challenge]} rõ hơn rồi chụp lại.`);
    // Moving on the other axis instead of the asked one is not the challenge.
    const otherDeg = Math.abs(horizontal ? moved.pitch - plain.pitch : moved.yaw - plain.yaw);
    if (otherDeg > moveDeg) throw this.fail(`Ảnh thứ hai chưa đúng hướng. Hãy ${CHALLENGE_VERB[challenge]} rồi chụp lại.`);

    const same = await this.faceMatch.compare(input.plain, input.challengePhoto);
    if (same.outcome === 'scored' && same.similarity < this.faceMatch.threshold) {
      throw this.fail('Hai ảnh không giống cùng một người. Vui lòng chụp lại.');
    }

    const match = await this.matchRegistered(input.userId, input.plain);
    if (!this.reviewEnabled || match.similarity === null || match.similarity >= this.faceMatch.threshold) {
      return this.passed(match.note, match.similarity);
    }

    // Below the threshold: one retake, then the face waits for a service manager. Retake is free, but a clearly
    // different face tells the managers right away.
    const alert = match.similarity < this.alertBelow;
    if (this.reviews && (await this.reviews.retakeCount(input.orderId, input.userId)) < 1) {
      await this.reviews.recordRetake(input.orderId, input.userId, match.similarity);
      if (alert) await this.reviews.notifyFlagged(input.orderId, input.userId, match.similarity);
      throw this.fail('Khuôn mặt chưa khớp ảnh đăng ký. Vui lòng chụp lại ở nơi đủ sáng, nhìn thẳng vào camera, bỏ khẩu trang và kính.');
    }
    return { note: match.note, review: { similarity: match.similarity, pending: true } };
  }

  /** A pass leaves a row only under the review rule, so a face rejected earlier is cleared by the new photo. */
  private passed(note: string, similarity: number | null): CheckinFaceResult {
    return this.reviewEnabled ? { note, review: { similarity, pending: false } } : { note };
  }

  private async matchRegistered(userId: string, plain: Buffer): Promise<{ note: string; similarity: number | null }> {
    const doc = await this.documents
      .createQueryBuilder('d')
      .innerJoin('d.verification', 'v')
      .where('v.technician_id = :userId', { userId })
      .andWhere('d.document_type = :type', { type: DocumentType.FACE_PHOTO })
      .andWhere('d.storage_object_path IS NOT NULL')
      .orderBy('d.created_at', 'DESC')
      .getOne();
    if (!doc?.storageObjectPath) return { note: 'Liveness đạt. Chưa có ảnh đăng ký để đối chiếu.', similarity: null };
    let registered: Buffer;
    try {
      registered = await this.kyc.download(doc.storageObjectPath, userId);
    } catch {
      return { note: 'Liveness đạt. Chưa đọc được ảnh đăng ký để đối chiếu.', similarity: null };
    }
    const result = await this.faceMatch.compare(plain, registered);
    if (result.outcome !== 'scored') return { note: 'Liveness đạt. Chưa đối chiếu được với ảnh đăng ký.', similarity: null };
    return {
      similarity: result.similarity,
      note: result.similarity >= this.faceMatch.threshold
        ? `Liveness đạt. Khớp ảnh đăng ký ${result.similarity}%.`
        : `CẦN KIỂM TRA: khuôn mặt chỉ khớp ảnh đăng ký ${result.similarity}% (ngưỡng ${this.faceMatch.threshold}%).`,
    };
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
