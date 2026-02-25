import { config } from '../config.js';

// Simple in-memory rate limiter
const requestCounts = new Map();

// Clean up old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of requestCounts.entries()) {
    if (now - data.windowStart > config.rateLimit.windowMs) {
      requestCounts.delete(key);
    }
  }
}, 60000); // Clean up every minute

export function rateLimit(req, res, next) {
  // Use IP address as identifier (could also use API key for authenticated routes)
  const identifier = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();
  
  let data = requestCounts.get(identifier);
  
  if (!data || now - data.windowStart > config.rateLimit.windowMs) {
    // Start new window
    data = { windowStart: now, count: 1 };
    requestCounts.set(identifier, data);
  } else {
    data.count++;
  }
  
  // Set rate limit headers
  res.setHeader('X-RateLimit-Limit', config.rateLimit.maxRequests);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, config.rateLimit.maxRequests - data.count));
  res.setHeader('X-RateLimit-Reset', Math.ceil((data.windowStart + config.rateLimit.windowMs) / 1000));
  
  if (data.count > config.rateLimit.maxRequests) {
    return res.status(429).json({ 
      error: 'Too many requests. Please try again later.',
      retryAfter: Math.ceil((data.windowStart + config.rateLimit.windowMs - now) / 1000),
    });
  }
  
  next();
}
