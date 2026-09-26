// src/common/filters/http-exception.filter.spec.ts
import { describe, expect, it, vi } from 'vitest';
import {
  ArgumentsHost,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

describe('HttpExceptionFilter', () => {
  const filter = new HttpExceptionFilter();

  const createMockArgumentsHost = (url = '/api/v1/test') => {
    const jsonMock = vi.fn();
    const statusMock = vi.fn().mockReturnValue({ json: jsonMock });

    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ url, method: 'GET' }),
        getResponse: () => ({ status: statusMock }),
      }),
    } as unknown as ArgumentsHost;

    return { host, statusMock, jsonMock };
  };

  it('formats standard HttpException correctly', () => {
    const { host, statusMock, jsonMock } =
      createMockArgumentsHost('/api/v1/users/999');
    const exception = new NotFoundException('User not found');

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 404,
        error: {
          code: 'NOT_FOUND',
          message: 'User not found',
        },
        path: '/api/v1/users/999',
      }),
    );
  });

  it('formats ValidationPipe error array with code VALIDATION_FAILED and details', () => {
    const { host, statusMock, jsonMock } = createMockArgumentsHost(
      '/api/v1/auth/register',
    );
    const validationMessages = [
      'email must be an email',
      'password is too short',
    ];
    const exception = new BadRequestException({
      message: validationMessages,
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(400);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 400,
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Validation failed',
          details: validationMessages,
        },
        path: '/api/v1/auth/register',
      }),
    );
  });

  it('hides internal error messages in production mode', () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const { host, statusMock, jsonMock } =
      createMockArgumentsHost('/api/v1/internal');
    const exception = new Error('SELECT * FROM secret_table syntax error');

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        statusCode: 500,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Internal server error',
        },
      }),
    );

    process.env.NODE_ENV = originalEnv;
  });

  /**
   * Lỗi do body parser của Express ném ra không phải HttpException nên trước
   * đây rơi hết xuống nhánh 500. Đo thật trên backend đang chạy: một body 200KB
   * trả về HTTP 500 "Internal server error" kèm cả stack trace, thay vì 413.
   */
  describe('lỗi từ body parser của Express', () => {
    /** Dựng lại đúng hình dạng đối tượng lỗi của thư viện http-errors. */
    const createHttpError = (
      name: string,
      status: number,
      type: string,
      message: string,
    ) => {
      const error = new Error(message);
      error.name = name;
      return Object.assign(error, { status, statusCode: status, expose: true, type });
    };

    it('trả 413 khi body vượt quá giới hạn', () => {
      const { host, statusMock, jsonMock } =
        createMockArgumentsHost('/api/v1/auth/register');
      const exception = createHttpError(
        'PayloadTooLargeError',
        413,
        'entity.too.large',
        'request entity too large',
      );

      filter.catch(exception, host);

      expect(statusMock).toHaveBeenCalledWith(413);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          statusCode: 413,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request payload is too large',
          },
        }),
      );
    });

    // Ca này kiểm hợp đồng của riêng filter. Trên hệ thống đang chạy, adapter
    // của Nest bọc lỗi JSON sai cú pháp thành BadRequestException trước khi tới
    // đây, nên nhánh dưới không phải đường đi thật của lỗi đó lúc này — nó là
    // lưới đỡ nếu adapter đổi cách xử lý.
    it('trả 400 khi nhận lỗi parse ở dạng thô', () => {
      const { host, statusMock, jsonMock } =
        createMockArgumentsHost('/api/v1/auth/login');
      const exception = createHttpError(
        'SyntaxError',
        400,
        'entity.parse.failed',
        'Unexpected token } in JSON at position 17',
      );

      filter.catch(exception, host);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          error: { code: 'BAD_REQUEST', message: 'Malformed request body' },
        }),
      );
    });

    it('giữ nguyên hành vi 400 cho lỗi parse đã được adapter bọc sẵn', () => {
      const { host, statusMock, jsonMock } =
        createMockArgumentsHost('/api/v1/auth/login');
      // Đúng hình dạng đo được trên hệ thống đang chạy.
      const exception = new BadRequestException(
        `Unexpected token '}', ..."password":}" is not valid JSON`,
      );

      filter.catch(exception, host);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 400,
          error: expect.objectContaining({ code: 'BAD_REQUEST' }),
        }),
      );
    });

    it('không trả lại nguyên văn thông báo của thư viện', () => {
      const { host, jsonMock } = createMockArgumentsHost('/api/v1/auth/login');
      const exception = createHttpError(
        'SyntaxError',
        400,
        'entity.parse.failed',
        'Unexpected token } in JSON at position 17',
      );

      filter.catch(exception, host);

      const payload = jsonMock.mock.calls[0][0] as {
        error: { message: string };
      };
      expect(payload.error.message).not.toContain('position 17');
    });

    it('vẫn coi lỗi 5xx là lỗi nội bộ dù có cờ expose', () => {
      const { host, statusMock, jsonMock } =
        createMockArgumentsHost('/api/v1/internal');
      const exception = Object.assign(new Error('upstream exploded'), {
        status: 502,
        statusCode: 502,
        expose: true,
      });

      filter.catch(exception, host);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          statusCode: 500,
          error: expect.objectContaining({ message: 'Internal server error' }),
        }),
      );
    });

    it('không đụng tới lỗi thường không có cờ expose', () => {
      const { host, statusMock } = createMockArgumentsHost('/api/v1/internal');
      const exception = Object.assign(new Error('boom'), { status: 418 });

      filter.catch(exception, host);

      expect(statusMock).toHaveBeenCalledWith(500);
    });
  });
});
