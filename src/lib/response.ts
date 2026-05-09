/**
 * Standardized response helpers — used by every route handler.
 *
 * ok()  → { data: T } envelope with status 200 + version headers
 * fail() → { error: string, code: string, details?: {...} } for errors
 *
 * Both inject X-Marrow-Version / X-Marrow-SDK-Latest / X-Marrow-MCP-Latest.
 * CORS headers are handled by the error boundary middleware, not here.
 */

const MARROW_API_VERSION = '2026.03.29';
const MARROW_SDK_LATEST  = '3.7.19';
const MARROW_MCP_LATEST  = '3.9.20';

export function ok<T>(data: T, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Marrow-Version': MARROW_API_VERSION,
      'X-Marrow-SDK-Latest': MARROW_SDK_LATEST,
      'X-Marrow-MCP-Latest': MARROW_MCP_LATEST,
      ...extraHeaders,
    },
  });
}

export function fail(
  code: string,
  message: string,
  status = 500,
  details?: Record<string, unknown>,
): Response {
  const body: Record<string, unknown> = { error: message, code };
  if (details) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
