// 图片解码探测：导入时与呈现前都用它判断 Blob 是否能被浏览器解码。
// 单张失败只标记/回传该项，不影响其他页。

export type ImageProbeResult = { ok: true; width: number; height: number } | { ok: false };

/**
 * 尝试解码 Blob。优先 createImageBitmap；不可用时退到 Image + objectURL。
 * @param timeoutMs 超时即判失败，避免坏数据长时间挂起
 */
export async function probeImageDecode(blob: Blob, timeoutMs = 8000): Promise<ImageProbeResult> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const dims = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return { ok: true, ...dims };
    } catch {
      return { ok: false };
    }
  }

  const url = URL.createObjectURL(blob);
  try {
    const dims = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('decode timeout')), timeoutMs);
      const img = new Image();
      img.onload = () => {
        clearTimeout(timer);
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        clearTimeout(timer);
        reject(new Error('decode error'));
      };
      img.src = url;
    });
    return { ok: true, ...dims };
  } catch {
    return { ok: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}
