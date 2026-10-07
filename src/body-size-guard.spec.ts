import { describe, expect, it, vi } from 'vitest';
import { PayloadTooLargeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { formBodySizeGuard, MAX_FORM_BODY_BYTES } from './setup-app';

const run = (url: string, length: number) => {
  const next = vi.fn();
  formBodySizeGuard({ originalUrl: url, headers: { 'content-length': String(length) } } as unknown as Request, {} as Response, next);
  return next.mock.calls[0][0];
};

describe('Request body size', () => {
  it('turns away a large body on an ordinary route', () => {
    expect(run('/api/v1/auth/login', MAX_FORM_BODY_BYTES + 1)).toBeInstanceOf(PayloadTooLargeException);
    expect(run('/api/v1/bookings?x=1', 2 * MAX_FORM_BODY_BYTES)).toBeInstanceOf(PayloadTooLargeException);
  });

  it('lets an ordinary body through', () => {
    expect(run('/api/v1/auth/login', 500)).toBeUndefined();
  });

  it('lets photos through on the AI routes only', () => {
    expect(run('/api/v1/ai/diagnoses', 30 * MAX_FORM_BODY_BYTES)).toBeUndefined();
    expect(run('/api/v1/ai-diagnosis/analyze/', 30 * MAX_FORM_BODY_BYTES)).toBeUndefined();
    expect(run('/api/v1/ai/chat/ask', 2 * MAX_FORM_BODY_BYTES)).toBeInstanceOf(PayloadTooLargeException);
  });
});
