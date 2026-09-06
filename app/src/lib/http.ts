/** Abort both the request and response-body read when the host stops answering. */
export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 4000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function rebuildDashboard(): Promise<void> {
  const result = await fetchJson<{ ok?: boolean }>("rebuild", { method: "POST" }, 310000);
  if (result.ok !== true) throw new Error("Dashboard rebuild failed");
}
