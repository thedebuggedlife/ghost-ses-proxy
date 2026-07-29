import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { CdkAppConfig } from './config.js';

export interface GhostSesProxyStackProps extends StackProps {
  readonly config: CdkAppConfig;
}

export class GhostSesProxyStack extends Stack {
  constructor(scope: Construct, id: string, props: GhostSesProxyStackProps) {
    super(scope, id, props);
  }
}
