export interface RollbackStep {
  label: string;
  cmd: string;
  args: string[];
}

export interface RollbackOptions {
  deploymentId?: string;
  message?: string;
}

export function buildRollbackPlan(
  targetName: string,
  options?: RollbackOptions,
  launcher?: string[],
): RollbackStep[];
