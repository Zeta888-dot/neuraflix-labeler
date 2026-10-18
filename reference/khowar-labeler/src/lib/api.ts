// Browser-side API client. Only `import type` from server modules (no fs in the bundle).
import type { SegParams } from "./segment";
import type { LineInfo, PageDetail, PageSummary } from "./storage";

export type { LineInfo, PageDetail, PageSummary, SegParams };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : res.statusText;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const pad2 = (i: number) => String(i).padStart(2, "0");

// ---------------------------------------------------------------- pages
export async function listPages(): Promise<PageSummary[]> {
  return (await request<{ pages: PageSummary[] }>("/api/pages")).pages;
}

export function uploadScans(files: File[]) {
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  return request<{ created: string[]; errors: { name: string; error: string }[] }>(
    "/api/pages",
    { method: "POST", body: fd }
  );
}

export function getPage(id: string) {
  return request<PageDetail>(`/api/pages/${id}`);
}

export function deletePage(id: string) {
  return request<{ ok: true }>(`/api/pages/${id}`, { method: "DELETE" });
}

export function resegment(id: string, params: SegParams, force = false) {
  return request<{ ok: true }>(`/api/pages/${id}/resegment`, json("POST", { params, force }));
}

// ---------------------------------------------------------------- lines
export async function saveLabel(id: string, i: number, text: string): Promise<string> {
  return (await request<{ label: string }>(`/api/pages/${id}/lines/${i}`, json("PUT", { text })))
    .label;
}

export function deleteLine(id: string, i: number) {
  return request<{ ok: true }>(`/api/pages/${id}/lines/${i}`, { method: "DELETE" });
}

// --------------------------------------------------------------- export
export function exportDataset() {
  return request<{ ok: true; count: number; path: string; url: string }>("/api/export", {
    method: "POST",
  });
}

// ---------------------------------------------------------------- urls
// `v` is a cache-buster (bump it after resegment so browsers refetch)
export const lineImageUrl = (id: string, i: number, v: string | number = 0) =>
  `/api/files/${id}/image_${pad2(i)}.jpg?v=${v}`;

export const overlayUrl = (id: string, v: string | number = 0) =>
  `/api/files/${id}/overlay.jpg?v=${v}`;