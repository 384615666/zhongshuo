import { z } from 'zod';

/** Execution channels share one catalog across configuration, dispatch and UI. */
export const REAL_RUNTIME_KINDS = ['claude', 'codex', 'deepseek-harness', 'pi'] as const;
export const RUNTIME_KINDS = [...REAL_RUNTIME_KINDS, 'fake'] as const;
export type RealRuntimeKind = typeof REAL_RUNTIME_KINDS[number];
export type RuntimeKind = typeof RUNTIME_KINDS[number];
export const runtimeKindSchema = z.enum(RUNTIME_KINDS);
export const RUNTIME_CHANNELS = [
  { value: 'claude', label: 'Claude CLI', executable: 'claude' },
  { value: 'codex', label: 'Codex CLI', executable: 'codex' },
  { value: 'deepseek-harness', label: 'DeepSeek Harness', executable: 'dsh' },
  { value: 'pi', label: 'Pi', executable: 'pi' },
] as const;
export function isRealRuntimeKind(value: unknown): value is RealRuntimeKind {
  return typeof value === 'string' && (REAL_RUNTIME_KINDS as readonly string[]).includes(value);
}
export function isRuntimeKind(value: unknown): value is RuntimeKind {
  return value === 'fake' || isRealRuntimeKind(value);
}
export function runtimeExecutable(kind: string): string {
  return RUNTIME_CHANNELS.find(channel => channel.value === kind)?.executable ?? kind;
}
