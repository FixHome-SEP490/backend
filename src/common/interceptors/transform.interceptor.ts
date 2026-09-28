// src/common/interceptors/transform.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface TransformedResponse<T> {
  success: boolean;
  statusCode: number;
  message: string;
  data: T;
  meta?: unknown;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  TransformedResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<TransformedResponse<T>> {
    const statusCode = context.switchToHttp().getResponse().statusCode;

    return next.handle().pipe(
      map((data) => {
        if (data === null || data === undefined) {
          return {
            success: true,
            statusCode,
            message: 'Success',
            data: null as unknown as T,
          };
        }

        // If already formatted with success property
        if (
          typeof data === 'object' &&
          'success' in data &&
          typeof (data as Record<string, unknown>).success === 'boolean'
        ) {
          const resObj = data as Record<string, unknown>;
          const { success: _s, statusCode: code, message, meta, data: innerData, ...rest } = resObj;
          const finalData = 'data' in resObj ? innerData : (Object.keys(rest).length > 0 ? rest : null);
          return {
            success: resObj.success as boolean,
            statusCode: (code as number) || statusCode,
            message: (message as string) || 'Success',
            data: (finalData as T) ?? (null as unknown as T),
            ...(meta ? { meta } : {}),
          };
        }

        // Controller already returned an envelope shape: { data, meta?, message? }.
        // Unwrap it instead of nesting it again under a second `data` key.
        // (Most controllers self-wrap their result as `{ data: x }`; only paginated
        // endpoints add `meta` alongside it, so `meta` is optional here.)
        if (
          typeof data === 'object' &&
          data !== null &&
          !Array.isArray(data) &&
          'data' in data
        ) {
          const {
            data: innerData,
            meta,
            message,
          } = data as Record<string, unknown>;
          return {
            success: true,
            statusCode,
            message: (message as string) || 'Success',
            data: innerData as T,
            ...(meta !== undefined ? { meta } : {}),
          };
        }

        return {
          success: true,
          statusCode,
          message: 'Success',
          data,
        };
      }),
    );
  }
}
