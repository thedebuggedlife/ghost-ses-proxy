import { Stack, type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

export interface GhostSesProxyStackConfig {
  readonly sesDomain: string;
  readonly awsRegion: string;
  readonly stackName: string;
}

export interface GhostSesProxyStackProps extends StackProps {
  readonly config: GhostSesProxyStackConfig;
}

export class GhostSesProxyStack extends Stack {
  constructor(scope: Construct, id: string, props: GhostSesProxyStackProps) {
    super(scope, id, props);
  }
}
