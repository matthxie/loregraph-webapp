/**
 * Fetch wrapper for the graph service: attaches the Supabase token, maps error bodies onto
 * Errors the UI already knows how to read. See API.md §1.
 */
import { accessToken, supabase } from "./supabase";
import { USAGE_LIMIT_PREFIX } from "../shared/api";

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

/** True when no service is configured — the app runs on lib/mockServer.ts instead. */
export const USE_MOCK = !API_BASE_URL;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Raw body for binary posts (dictation wav). */
  raw?: BodyInit;
  contentType?: string;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(path.replace(/^\//, ""), API_BASE_URL.replace(/\/?$/, "/"));
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function authHeaders(contentType?: string): Promise<HeadersInit> {
  const token = await accessToken();
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function toError(response: Response): Promise<ApiError> {
  let code = "unknown";
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // Non-JSON error body — the status line stands in.
  }
  // The composer, chat and dictation all recognise this prefix and show the plain sentence.
  if (response.status === 402 && !message.startsWith(USAGE_LIMIT_PREFIX)) {
    message = `${USAGE_LIMIT_PREFIX} ${message}`;
  }
  return new ApiError(message, response.status, code);
}

/** One request. A 401 refreshes the session once, then gives up and lets the shell sign out. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (): Promise<Response> => {
    const contentType = options.raw
      ? options.contentType
      : options.body !== undefined
        ? "application/json"
        : undefined;
    return fetch(buildUrl(path, options.query), {
      method: options.method ?? (options.body !== undefined || options.raw ? "POST" : "GET"),
      headers: await authHeaders(contentType),
      body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
      signal: options.signal,
    });
  };

  let response = await send();
  if (response.status === 401) {
    const { data } = await supabase.auth.refreshSession();
    if (data.session) response = await send();
  }
  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Open an SSE stream, yielding parsed `data:` payloads until the server closes it. */
export async function* stream<T>(
  path: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const response = await fetch(buildUrl(path), {
    method: "POST",
    headers: { ...(await authHeaders("application/json")), Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await toError(response);
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        yield JSON.parse(payload) as T;
      } catch {
        // Malformed frame — skip it rather than killing the run.
      }
    }
  }
}
