// src/common/filters/http-exception.filter.ts
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

/**
 * Lỗi do middleware của Express ném ra trước khi request chạm tới Nest.
 *
 * Body parser dùng thư viện `http-errors`: đối tượng lỗi mang sẵn `status` và
 * cờ `expose` báo rằng thông báo này an toàn để trả về cho client. Chúng không
 * phải `HttpException` nên trước đây rơi xuống nhánh 500, khiến một body quá
 * khổ bị báo là "Internal server error" kèm stack trace thay vì 413.
 *
 * Đo trên hệ thống đang chạy thì adapter của Nest có bọc sẵn lỗi JSON sai cú
 * pháp thành `BadRequestException` (nên ca đó vốn đã trả 400 đúng), nhưng lỗi
 * body quá khổ thì đi thẳng tới đây ở dạng thô. Các nhánh còn lại bên dưới giữ
 * lại để phòng khi adapter đổi cách xử lý.
 */
interface ExposedHttpError extends Error {
  status?: number;
  statusCode?: number;
  expose?: boolean;
  type?: string;
}

function asExposedClientError(
  exception: unknown,
): { status: number; message: string } | null {
  if (!(exception instanceof Error)) return null;
  const candidate = exception as ExposedHttpError;
  if (candidate.expose !== true) return null;

  const status = candidate.status ?? candidate.statusCode;
  if (typeof status !== 'number' || status < 400 || status > 499) return null;

  // Thông báo cố định theo loại lỗi, không lấy nguyên văn từ thư viện, để không
  // vô tình trả lại một mẩu nội dung request cho người gửi.
  if (candidate.type === 'entity.too.large') {
    return { status, message: 'Request payload is too large' };
  }
  if (candidate.type === 'entity.parse.failed') {
    return { status, message: 'Malformed request body' };
  }
  if (candidate.type === 'charset.unsupported' || candidate.type === 'encoding.unsupported') {
    return { status, message: 'Unsupported request encoding' };
  }
  return { status, message: 'Bad request' };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let code = 'INTERNAL_SERVER_ERROR';
    let details: unknown = undefined;

    const exposedClientError = asExposedClientError(exception);

    if (exposedClientError) {
      status = exposedClientError.status;
      message = exposedClientError.message;
      code = this.getErrorCodeFromStatus(status);
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const responseObj = exceptionResponse as Record<string, unknown>;
        message = (responseObj.message as string) || message;
        if (responseObj.code) {
          code = String(responseObj.code);
        }

        if (Array.isArray(responseObj.message)) {
          details = responseObj.message;
          message = 'Validation failed';
          code = 'VALIDATION_FAILED';
        }
      }

      if (code === 'INTERNAL_SERVER_ERROR') {
        code = this.getErrorCodeFromStatus(status);
      }
    } else if (
      exception instanceof QueryFailedError &&
      (exception.driverError as { code?: string }).code === '23505'
    ) {
      status = HttpStatus.CONFLICT;
      message = 'A record with these identifiers already exists';
      code = 'CONFLICT';
    } else if (
      exception instanceof QueryFailedError &&
      (exception.driverError as { code?: string }).code === '23514'
    ) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Data violates a business constraint';
      code = 'BAD_REQUEST';
    }
    if (status >= 500) {
      this.logger.error(
        `Request failed: ${request.method} ${request.path || request.url.split('?')[0]} (${status})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
      message =
        status === 503 ? 'Service unavailable' : 'Internal server error';
      code = this.getErrorCodeFromStatus(status);
      if (process.env.NODE_ENV !== 'production' && exception instanceof Error) {
        details = { message: exception.message, stack: exception.stack };
      } else {
        details = undefined;
      }
    } else {
      this.logger.warn(
        `Request warning: ${request.method} ${request.path || request.url.split('?')[0]} (${status}) - ${message}`,
      );
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
      timestamp: new Date().toISOString(),
      path: request.path || request.url.split('?')[0],
    });
  }

  private getErrorCodeFromStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'BAD_REQUEST';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
        return 'UNPROCESSABLE_ENTITY';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'TOO_MANY_REQUESTS';
      default:
        return HttpStatus[status] || 'INTERNAL_SERVER_ERROR';
    }
  }
}
