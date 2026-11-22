import { randomUUID } from 'crypto';
import { In, type EntityManager } from 'typeorm';
import { BusinessException } from '../../common/exceptions/business.exception';
import { ErrorCodes } from '../../shared/constants';
import { CheckinFaceReview } from './entities/checkin-face-review.entity';

export type CheckinFaceReviewView = { status: 'pending' | 'approved' | 'rejected'; note: string | null } | null;

/** What a successful check-in face upload decided; `pending` waits for a service manager. */
export type CheckinFaceOutcome = { similarity: number | null; pending: boolean };

/** The latest outcome of the check-in face that is not a retake request; null when the face was never reviewed (older orders). */
export async function latestCheckinFaceReview(manager: EntityManager, orderId: string, technicianId: string): Promise<CheckinFaceReviewView> {
  const row = await manager.findOne(CheckinFaceReview, {
    where: { serviceOrderId: orderId, technicianId, status: In(['pending', 'approved', 'rejected']) },
    order: { createdAt: 'DESC' },
  });
  return row ? { status: row.status as 'pending' | 'approved' | 'rejected', note: row.reviewNote ?? null } : null;
}

/** Blocks the next step while the face waits for a service manager or was rejected; orders with no review pass. */
export async function assertCheckinFaceCleared(manager: EntityManager, orderId: string, technicianId: string): Promise<void> {
  const review = await latestCheckinFaceReview(manager, orderId, technicianId);
  if (!review || review.status === 'approved') return;
  throw new BusinessException(
    ErrorCodes.ORDER_INVALID_TRANSITION,
    review.status === 'pending'
      ? 'Khuôn mặt check-in đang chờ quản lý dịch vụ xác nhận.'
      : 'Khuôn mặt check-in chưa được xác nhận. Vui lòng chụp lại.',
  );
}

/**
 * Writes the outcome for the order and every order of the visit in the same transaction as the evidence,
 * under one group id so a single manager decision opens them all.
 */
export async function recordCheckinFaceOutcome(
  manager: EntityManager,
  technicianId: string,
  outcome: CheckinFaceOutcome,
  targets: Array<{ orderId: string; evidenceId: string }>,
): Promise<void> {
  const groupId = randomUUID();
  await manager.save(CheckinFaceReview, targets.map(t => manager.create(CheckinFaceReview, {
    groupId,
    serviceOrderId: t.orderId,
    technicianId,
    evidenceId: t.evidenceId,
    similarity: outcome.similarity,
    status: outcome.pending ? 'pending' : 'approved',
  })));
}
