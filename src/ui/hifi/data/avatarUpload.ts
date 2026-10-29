/** Read and decode the original image without resizing or a fixed size limit. */
export function readAvatarFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败，未保存'));
    reader.onabort = () => reject(new Error('图片读取已取消，未保存'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('图片读取失败，未保存'));
        return;
      }
      // Browser MIME metadata can be empty or incorrect. Check the actual bytes.
      const encoded = reader.result.slice(reader.result.indexOf(',') + 1);
      const mime = encoded.startsWith('iVBORw0KGgo') ? 'image/png'
        : encoded.startsWith('/9j/') ? 'image/jpeg'
        : encoded.startsWith('UklGR') && atob(encoded.slice(0, 16)).slice(8, 12) === 'WEBP' ? 'image/webp'
        : null;
      if (mime == null) {
        reject(new Error('请选择 PNG、JPEG 或 WebP 图片'));
        return;
      }
      const dataUrl = `data:${mime};base64,${encoded}`;
      const image = new Image();
      image.onerror = () => reject(new Error('图片损坏或格式不受支持，未保存'));
      image.onload = () => {
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
          reject(new Error('图片无效，未保存'));
          return;
        }
        resolve(dataUrl);
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}
