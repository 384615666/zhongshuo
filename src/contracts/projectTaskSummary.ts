/** Persisted counts for one explicitly selected project and the current local audience. */
export interface ProjectTaskSummary {
  projectId: string;
  /** Tasks excluding DONE and CANCELLED, including queued, review, blocked and waiting work. */
  unfinishedTasks: number;
  /** Agent turns still in-flight; UNKNOWN is excluded because its outcome is unresolved. */
  activeTurns: number;
}
