export interface DeploymentMetadata {
  version: string;
  commit: string;
  deployed_at: string;
}

export function validateDeploymentMetadata(metadata: DeploymentMetadata): DeploymentMetadata;
export function deploymentDefineArgs(metadata: DeploymentMetadata): string[];
export function readDeploymentMetadata(
  base: string,
  fetcher?: typeof fetch,
): Promise<DeploymentMetadata>;
export function verifyDeploymentMetadata(
  base: string,
  expected: DeploymentMetadata,
  fetcher?: typeof fetch,
): Promise<DeploymentMetadata>;
export function verifyDualDeployment(
  targets: Record<string, string>,
  expected: DeploymentMetadata,
  fetcher?: typeof fetch,
): Promise<Record<string, DeploymentMetadata>>;
