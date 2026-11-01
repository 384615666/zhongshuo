/** Native CLI catalog startup is bounded at 30 seconds. Transport and renderer
 * receipt windows must allow that read to finish without timing out earlier. */
export function isRuntimeMetadataRead(method: unknown): boolean {
  return method === 'member.runtimeCatalog' || method === 'member.runtimeOptions';
}
export const RUNTIME_METADATA_PIPE_DEADLINE_MS = 40_000;
export const RUNTIME_METADATA_RECEIPT_DEADLINE_MS = 45_000;
