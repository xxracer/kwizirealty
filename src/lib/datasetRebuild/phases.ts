/** Phases shared between the rebuild worker and its client singleton. */
export type RebuildPhase =
  | 'preparing'
  | 'downloading'
  | 'processing'
  | 'uploading'
  | 'finalizing'
  | 'done'
  | 'error';