import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { AuthStack } from "../lib/auth_stack";
import { ApiStack } from "../lib/api_stack";

const app = new cdk.App();

const env = {
	account: process.env.CDK_DEFAULT_ACCOUNT,
	region: process.env.CDK_DEFAULT_REGION ?? "eu-central-1",
};

const auth = new AuthStack(app, "WorkoutAuthStack", { env });

new ApiStack(app, "WorkoutApiStack", {
	env,
	userPool: auth.userPool,
});
