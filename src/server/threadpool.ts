// Imported first by main.ts: Node's file-system calls share a pool of 4 threads by default, which serialises the
// directory listings and reads of a scan over a cloud-synced drive. The size must be set before the pool is first used.
process.env.UV_THREADPOOL_SIZE ??= '32';
