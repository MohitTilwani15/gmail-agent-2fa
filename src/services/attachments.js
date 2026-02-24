// Timeout for fetching attachments (30 seconds)
const FETCH_TIMEOUT_MS = 30000;

// Validate URL to prevent SSRF attacks
function isUrlSafe(urlString) {
  try {
    const url = new URL(urlString);
    
    // Only allow http and https protocols
    if (!['http:', 'https:'].includes(url.protocol)) {
      return false;
    }
    
    // Block internal/private IP ranges
    const hostname = url.hostname.toLowerCase();
    
    // Block localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return false;
    }
    
    // Block private IP ranges (basic check)
    const ipPatterns = [
      /^10\./,                          // 10.0.0.0/8
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
      /^192\.168\./,                    // 192.168.0.0/16
      /^169\.254\./,                    // Link-local
      /^0\./,                           // 0.0.0.0/8
    ];
    
    for (const pattern of ipPatterns) {
      if (pattern.test(hostname)) {
        return false;
      }
    }
    
    // Block internal hostnames
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

// Fetch with timeout
async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

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
      // Validate URL to prevent SSRF attacks
      if (!isUrlSafe(att.url)) {
        throw new Error(`Attachment URL "${att.url}" is not allowed (internal or invalid URL)`);
      }
      
      const response = await fetchWithTimeout(att.url);
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
