// Email request status constants
export const STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DECLINED: 'declined',
  SENT: 'sent',
  FAILED: 'failed',
};

// Statuses that mark a request as resolved
export const RESOLVED_STATUSES = [
  STATUS.APPROVED,
  STATUS.DECLINED,
  STATUS.SENT,
  STATUS.FAILED,
];
