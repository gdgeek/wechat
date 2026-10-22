export class ApiError extends Error {
  responseBody?: unknown;
  constructor(public readonly status: number, message: string, public readonly errorName?: string, public readonly yiiType?: string) { super(message); }
}
export function errorPayload(error: unknown): { status: number; body: unknown } {
  const value = error as any;
  const status = value instanceof ApiError ? value.status : typeof value?.getStatus === 'function' ? value.getStatus() : 500;
  if (value?.responseBody !== undefined) return { status, body: value.responseBody };
  const names: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 409: 'Conflict', 410: 'Gone', 413: 'Request Entity Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable entity', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable' };
  const types: Record<number, string> = { 400: 'BadRequest', 401: 'Unauthorized', 403: 'Forbidden', 404: 'NotFound', 405: 'MethodNotAllowed', 406: 'NotAcceptable', 409: 'Conflict', 410: 'Gone', 413: 'RequestEntityTooLarge', 415: 'UnsupportedMediaType', 422: 'UnprocessableEntity', 429: 'TooManyRequests', 500: 'ServerError', 503: 'ServiceUnavailable' };
  let message = status < 500 || value instanceof ApiError ? value.message : 'An internal server error occurred.';
  if (typeof value?.getResponse === 'function') {
    const response = value.getResponse();
    if (Array.isArray(response) || typeof response === 'object' && !('message' in response)) return { status, body: response };
    message = typeof response === 'string' ? response : response.message;
  }
  // The deployed Yii API exposes public HTTP exception types. Keep these stable
  // without exposing runtime paths, stack traces, SQL details or credentials.
  const type = value?.yiiType ?? (value instanceof ApiError || typeof value?.getStatus === 'function' ? `${types[status] ?? ''}HttpException` : 'HttpException');
  return { status, body: { name: value?.errorName ?? names[status] ?? 'Internal Server Error', message, code: 0, status, type: `yii\\web\\${type}` } };
}
