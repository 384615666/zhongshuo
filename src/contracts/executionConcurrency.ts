import { z } from 'zod';

export const executionConcurrencyLimitsSchema = z.strictObject({
  globalMaxInFlight: z.number().int().min(1).max(32),
  perProjectMaxInFlight: z.number().int().min(1).max(32),
  perProviderMaxInFlight: z.number().int().min(1).max(32),
});

export type ExecutionConcurrencyLimits = z.infer<typeof executionConcurrencyLimitsSchema>;
export interface ExecutionConcurrencySettings {
  revision: number;
  limits: ExecutionConcurrencyLimits;
  source: 'default' | 'environment' | 'saved';
}

export const EXECUTION_CONCURRENCY_KEY = 'app:execution-concurrency';
export const DEFAULT_EXECUTION_CONCURRENCY: ExecutionConcurrencyLimits = {
  globalMaxInFlight: 4, perProjectMaxInFlight: 4, perProviderMaxInFlight: 4,
};
