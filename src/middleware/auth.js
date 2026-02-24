import crypto from 'crypto';
import { config } from '../config.js';

// In-memory session store (for production, use Redis or similar)
const sessions = new Map();

// Session expiry time (24 hours)
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}, 60000); // Clean up every minute

export function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const session = {
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_EXPIRY_MS,
  };
  sessions.set(token, session);
  return token;
}

export function validateSession(token) {
  if (!token) return false;
  const session = sessions.get(token);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token) {
  sessions.delete(token);
}

export function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== config.apiKey) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

export function requireDashboard(req, res, next) {
  // Check session cookie first (preferred)
  const sessionToken = req.cookies?.session;
  if (sessionToken && validateSession(sessionToken)) {
    return next();
  }
  
  // Check header-based auth (for backward compatibility)
  const key = req.headers['x-dashboard-key'];
  if (key && key === config.dashboardPassword) {
    return next();
  }
  
  // Also allow API key for backward compatibility / programmatic access
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === config.apiKey) {
    return next();
  }
  
  return res.status(401).json({ error: 'Invalid or missing credentials' });
}
