// Imported first by main.ts. Node's file-system calls share a pool of 4 threads by default, which serialises the
// directory listings and reads of a scan over a cloud-synced drive. The size cannot be raised from code (the pool is
// already running when this module loads): the launchers (studio.ps1, run.cmd) set UV_THREADPOOL_SIZE. This only warns.
/** Pool size the launchers ask for; below it, scans over a synced drive are slow. */
export const RECOMMENDED_THREADPOOL_SIZE = 32;

if (!process.env.UV_THREADPOOL_SIZE) {
  console.warn(`UV_THREADPOOL_SIZE is not set: file scans will be slow. Start Studio through the launcher, or set it to ${RECOMMENDED_THREADPOOL_SIZE} before node starts.`);
}
