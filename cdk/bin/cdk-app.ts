#!/usr/bin/env node
import 'dotenv/config';
import { App } from 'aws-cdk-lib';
import { GhostSesProxyStack } from '../lib/ghost-ses-proxy-stack.js';

const sesDomain = process.env.SES_DOMAIN;
if (!sesDomain) {
  console.error('SES_DOMAIN is required. Set it in cdk/.env (see cdk/.env.example).');
  process.exit(1);
}

const awsRegion = process.env.AWS_REGION ?? 'us-east-1';
const stackName = process.env.STACK_NAME ?? 'GhostSesProxy';

const app = new App();
new GhostSesProxyStack(app, stackName, {
  config: { sesDomain, awsRegion, stackName },
  env: {
    account: process.env.AWS_ACCOUNT_ID ?? process.env.CDK_DEFAULT_ACCOUNT,
    region: awsRegion,
  },
});
