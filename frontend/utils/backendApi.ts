/**
 * utils/backendApi.ts  —  Authentica Phase 4
 * ============================================
 * Typed wrappers around the Phase 3 FastAPI backend endpoints.
 */

import { BACKEND_URL, type JobStatus } from "./web3Config";

async function apiCall<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(body?.detail ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function uploadVideo(file: File): Promise<{ job_id: string; filename: string; size_mb: number }> {
  const form = new FormData();
  form.append("file", file);
  return apiCall("/upload", { method: "POST", body: form });
}

export async function triggerProcess(
  jobId: string,
  publish = true,
): Promise<{ job_id: string; status: string; message: string }> {
  return apiCall(`/process/${jobId}?publish=${publish}`, { method: "POST" });
}

export async function pollStatus(jobId: string): Promise<JobStatus> {
  return apiCall(`/status/${jobId}`);
}

export function exportUrl(jobId: string): string {
  return `${BACKEND_URL}/export/${jobId}`;
}
