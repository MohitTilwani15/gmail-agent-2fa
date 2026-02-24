import { config } from '../config.js';

export function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== config.apiKey) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  next();
}

export function requireDashboard(req, res, next) {
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
