export type ExternalRuntimeKind = 'deepseek-harness' | 'pi';
export interface AgentExecutable {
  command: string;
  prefixArgs: string[];
  env?: Record<string, string>;
  /** Real files underlying virtual ASAR script entries. */
  integrityFiles?: string[];
}
export class CliResolutionError extends Error {
  code: 'VALIDATION_INVALID' | 'RUNTIME_NOT_FOUND' | 'CAPABILITY_UNSUPPORTED';
  notStarted: true;
}
export function resolveCliExecutable(kind: ExternalRuntimeKind, explicit?: string): AgentExecutable;
