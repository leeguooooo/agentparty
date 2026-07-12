import type { DeploymentMetadata } from "./deployment-metadata.d.mts";

export interface DeployTarget {
  config: string;
  database: string;
  smokeBase: string;
}

export interface DeployStep {
  label: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
}

export const DEPLOY_TARGETS: Record<"prod" | "xdream", DeployTarget>;

export function parseWranglerLauncher(env?: Record<string, string | undefined>): string[];

export function buildDeployPlan(
  targetName: string,
  metadata: DeploymentMetadata,
  launcher?: string[],
): DeployStep[];
