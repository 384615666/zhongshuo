import { AdapterCallError } from '../../contracts/runtime.ts';
import { CliResolutionError, resolveCliExecutable } from './executable.mjs';
import type { AgentExecutable, ExternalRuntimeKind } from './executable.mjs';
export type { AgentExecutable, ExternalRuntimeKind } from './executable.mjs';

/** Resolve an installed CLI without invoking a shell or evaluating its shim. */
export function resolveAgentExecutable(kind: ExternalRuntimeKind, explicit?: string): AgentExecutable {
  try { return resolveCliExecutable(kind, explicit); }
  catch (error) {
    if (error instanceof CliResolutionError) throw new AdapterCallError(error.code, error.message, true);
    throw error;
  }
}
