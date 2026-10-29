// Each request stays below Cloudflare's per-request body limit; Pi streams chunks to disk.
export async function uploadChunks({
  kind,
  path,
  file,
  type = file.type,
  onProgress = () => {},
  headers = {},
}) {
  const base = "/api/ticket/uploads";
  const request = async (url, options = {}) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
      headers: { ...headers, ...options.headers },
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = { error: "Upload failed" };
    }
    if (!response.ok)
      throw Object.assign(new Error(data.error || "Upload failed"), {
        status: response.status,
      });
    return data;
  };
  const started = await request(base, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, path, type, size: file.size }),
  });
  let offset = started.offset;
  onProgress((offset / file.size) * 100);
  if (started.complete) return;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + started.chunkSize);
    let retries = 0;
    while (true) {
      try {
        const result = await request(`${base}/${started.id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/octet-stream",
            "Upload-Offset": String(offset),
          },
          body: file.slice(offset, end),
        });
        offset = result.offset;
        onProgress((offset / file.size) * 100);
        break;
      } catch (error) {
        if (error.status && error.status !== 409 && error.status < 500)
          throw error;
        if (++retries > 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * retries));
        const status = await request(`${base}/${started.id}`);
        if (status.offset !== offset) {
          offset = status.offset;
          onProgress((offset / file.size) * 100);
          break;
        }
      }
    }
  }
  // Cloud transfer continues on the Pi; short status requests avoid proxy timeouts.
  for(let checks=0;checks<7200;checks++){
    const status=await request(`${base}/${started.id}`);
    if(status.complete){onProgress(100);return;}
    onProgress(99);
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  throw new Error('Storage transfer is still running. Retry to resume.');
}
