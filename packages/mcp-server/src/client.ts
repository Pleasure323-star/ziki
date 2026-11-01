import type { ZikiConfig } from "./config.js";

export class ZikiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ZikiApiError";
  }
}

export type RequestSpec = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** Multipart upload. Sent as the `file` field instead of a JSON body. */
  file?: { filename: string; dataBase64: string };
  /** The path is at the site root, not under `/api/v1` (the project work feed). */
  siteRoute?: boolean;
};

type FetchLike = typeof fetch;

/** A thin authenticated wrapper over `/api/v1`. Every call is one HTTP request. */
export class ZikiClient {
  constructor(
    readonly config: ZikiConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request({ method, path, query, body, headers, file, siteRoute }: RequestSpec): Promise<unknown> {
    const url = new URL(siteRoute ? path : `/api/v1${path}`, this.config.url);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    let payload: BodyInit | undefined;
    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
      ...headers,
    };
    if (file) {
      const bytes = Buffer.from(file.dataBase64, "base64");
      const form = new FormData();
      form.set("file", new Blob([bytes]), file.filename);
      payload = form;
    } else if (body) {
      requestHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.fetchImpl(url, {
      method,
      headers: requestHeaders,
      body: payload,
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const detail =
        data && typeof data === "object" && "error" in data
          ? String((data as { error: unknown }).error)
          : response.statusText;
      throw new ZikiApiError(`${response.status} ${detail}`, response.status, data);
    }
    return data;
  }
}
