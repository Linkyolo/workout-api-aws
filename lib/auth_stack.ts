import * as cdk from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

export class AuthStack extends cdk.Stack {
	public readonly userPool: cognito.UserPool;

	constructor(scope: Construct, id: string, props: cdk.StackProps) {
		super(scope, id, props);

		this.userPool = new cognito.UserPool(this, "UserPool", {
			userPoolName: "workout-users",
			signInAliases: { email: true },
			autoVerify: { email: true },
			selfSignUpEnabled: true,

			passwordPolicy: {
				minLength: 8,
				requireUppercase: true,
				requireDigits: true,
				requireSymbols: false,
			},

			userVerification: {
				emailSubject: "Verify your workout tracker account",
				emailBody: "Your verification code is {####}",
				emailStyle: cognito.VerificationEmailStyle.CODE,
			},

			// Safe to destroy in dev — remove for production
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		const appClient = this.userPool.addClient("WorkoutAppClient", {
			userPoolClientName: "workout-app-client",
			authFlows: { userSrp: true, },
			generateSecret: false, // public client (SPA / mobile) — no secret

			accessTokenValidity: cdk.Duration.hours(1),
			idTokenValidity: cdk.Duration.hours(1),
			refreshTokenValidity: cdk.Duration.days(30),

			preventUserExistenceErrors: true,
		});

		new cdk.CfnOutput(this, "UserPoolId", {
			value: this.userPool.userPoolId,
			exportName: "WorkoutUserPoolId",
		});

		new cdk.CfnOutput(this, "UserPoolClientId", {
			value: appClient.userPoolClientId,
			exportName: "WorkoutUserPoolClientId",
		});
	}
}
