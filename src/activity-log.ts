/**
 * In-memory ring buffer for recent request activity.
 * Resets on restart — no persistence needed.
 */

export interface ActivityEntry {
  timestamp: string;
  method: string;
  path: string;
  model?: string;
  statusCode: number;
  durationMs: number;
}

const MAX_ENTRIES = 20;
const _buffer: ActivityEntry[] = [];

export function logActivity(entry: ActivityEntry): void {
  _buffer.push(entry);
  if (_buffer.length > MAX_ENTRIES) {
    _buffer.shift();
  }
}

export function getActivity(): ActivityEntry[] {
  // Return newest first
  return [..._buffer].reverse();
}
