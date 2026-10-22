export class ApiError extends Error {
  responseBody?: unknown;
  constructor(public readonly status: number, message: string, public readonly errorName?: string) { super(message); }
}
export function errorPayload(error: unknown): { status: number; body: unknown } {
  const value = error as any;
  const status = value instanceof ApiError ? value.status : typeof value?.getStatus === 'function' ? value.getStatus() : 500;
  if (value?.responseBody !== undefined) return { status, body: value.responseBody };
  const names: Record<number, string> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 422: 'Unprocessable Entity', 429: 'Too Many Requests', 503: 'Service Unavailable' };
  let message = status < 500 || value instanceof ApiError ? value.message : 'Service unavailable';
  if (typeof value?.getResponse === 'function') {
    const response = value.getResponse();
    if (Array.isArray(response) || typeof response === 'object' && !('message' in response)) return { status, body: response };
    message = typeof response === 'string' ? response : response.message;
  }
  return { status, body: { name: value.errorName ?? names[status] ?? 'Internal Server Error', message, code: 0, status } };
}
