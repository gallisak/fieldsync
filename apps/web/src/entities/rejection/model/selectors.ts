import type { StoredRejection } from '@fieldsync/sync-core';

export function newestFirst(rejections: readonly StoredRejection[]): StoredRejection[] {
  return [...rejections].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
}
