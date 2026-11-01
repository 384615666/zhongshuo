export type WriteConcurrencyOverride = 'single_writer' | 'parallel_writers' | null;
export type EffectiveWriteConcurrency = 'single_writer' | 'session_scope' | 'parallel_writers';

export interface ProjectWriteConcurrency {
  projectId: string;
  revision: number;
  override: WriteConcurrencyOverride;
  /** Applies to full-access room turns; restricted writes remain exclusive. */
  effectivePolicy: EffectiveWriteConcurrency;
}
