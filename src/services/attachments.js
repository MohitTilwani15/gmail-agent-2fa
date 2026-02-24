export async function processAttachments(attachments) {
  if (!attachments || attachments.length === 0) return [];

  const processed = [];

  for (const att of attachments) {
    if (att.base64) {
      processed.push({
        filename: att.filename,
        contentType: att.contentType,
        data: att.base64,
      });
    } else if (att.url) {
      const response = await fetch(att.url);
      if (!response.ok) {
        throw new Error(`Failed to download attachment from ${att.url}: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      processed.push({
        filename: att.filename,
        contentType: att.contentType || response.headers.get('content-type') || 'application/octet-stream',
        data: buffer.toString('base64'),
      });
    } else {
      throw new Error(`Attachment "${att.filename}" has neither base64 nor url`);
    }
  }

  return processed;
}
