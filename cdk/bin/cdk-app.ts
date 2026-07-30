#!/usr/bin/env node
import 'dotenv/config';
import { App } from 'aws-cdk-lib';
import { parseConfig, type CdkAppConfig } from '../lib/config.js';
import { GhostSesProxyStack } from '../lib/ghost-ses-proxy-stack.js';

function loadConfig(): CdkAppConfig {
  try {
    return parseConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const config = loadConfig();
const account = config.awsAccountId ?? process.env.CDK_DEFAULT_ACCOUNT;

if (config.hostedZoneName && !account) {
  console.error(
    'Route53 lookup needs an account: set AWS_ACCOUNT_ID in cdk/.env or configure AWS credentials.',
  );
  process.exit(1);
}

const app = new App();
new GhostSesProxyStack(app, config.stackName, {
  config,
  env: { account, region: config.awsRegion },
});
