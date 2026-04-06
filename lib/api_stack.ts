import * as cdk from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as path from "path";
import { Construct } from "constructs";

interface ApiStackProps extends cdk.StackProps {
	userPool: cognito.UserPool;
}

export class ApiStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props: ApiStackProps) {
		super(scope, id, props);

		// ── SSM Parameter Store (free) ────────────────────────────────────────────
		// Create manually in the AWS Console:
		//   Parameter name: /workout/neon-connection-string
		//   Type: SecureString
		//   Value: your Neon DATABASE_URL
		const neonParam = ssm.StringParameter.fromSecureStringParameterAttributes(
			this,
			"NeonParam",
			{ parameterName: "/workout/neon-connection-string" }
		);

		// ── Shared Lambda config ──────────────────────────────────────────────────
		const sharedProps: Partial<nodejs.NodejsFunctionProps> = {
			runtime: lambda.Runtime.NODEJS_20_X,
			architecture: lambda.Architecture.ARM_64, // Graviton — cheaper + faster
			timeout: cdk.Duration.seconds(10),
			memorySize: 256,
			bundling: {
				minify: true,
				sourceMap: true,
				target: "node20",
				externalModules: [], // bundle everything — no Lambda layers needed
			},
			environment: {
				NODE_ENV: "production",
				NEON_SSM_PARAM: "/workout/neon-connection-string",
			},
		};

		// ── Lambda: workout service ───────────────────────────────────────────────
		const workoutsLambda = new nodejs.NodejsFunction(this, "WorkoutsLambda", {
			...sharedProps,
			functionName: "workout-service",
			entry: path.join(__dirname, "../src/functions/workouts/handler.ts"),
			description: "CRUD — workouts, workout-exercises, entries, climbing routes",
		});

		// ── Lambda: stats service ─────────────────────────────────────────────────
		const statsLambda = new nodejs.NodejsFunction(this, "StatsLambda", {
			...sharedProps,
			functionName: "stats-service",
			entry: path.join(__dirname, "../src/functions/stats/handler.ts"),
			description: "Aggregations — summary, frequency, exercise progression",
			// Stats queries are heavier — give them more headroom
			timeout: cdk.Duration.seconds(15),
			memorySize: 512,
		});

		neonParam.grantRead(workoutsLambda);
		neonParam.grantRead(statsLambda);

		// ── Cognito authorizer ────────────────────────────────────────────────────
		const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
			this,
			"CognitoAuthorizer",
			{
				cognitoUserPools: [props.userPool],
				authorizerName: "WorkoutCognitoAuthorizer",
				resultsCacheTtl: cdk.Duration.minutes(5),
			}
		);

		const protected_ = {
			authorizer,
			authorizationType: apigateway.AuthorizationType.COGNITO,
		};

		// ── API Gateway ───────────────────────────────────────────────────────────
		const api = new apigateway.RestApi(this, "WorkoutApi", {
			restApiName: "workout-api",

			defaultCorsPreflightOptions: {
				allowOrigins: apigateway.Cors.ALL_ORIGINS, // tighten in prod
				allowMethods: apigateway.Cors.ALL_METHODS,
				allowHeaders: ["Content-Type", "Authorization", "X-Amz-Date"],
			},

			deployOptions: {
				stageName: "v1",
				loggingLevel: apigateway.MethodLoggingLevel.INFO,
				metricsEnabled: true,
				dataTraceEnabled: false, // flip to true temporarily when debugging
			},
		});

		const workoutsInt = new apigateway.LambdaIntegration(workoutsLambda, { proxy: true });
		const statsInt = new apigateway.LambdaIntegration(statsLambda, { proxy: true });

		// ── /users/me — upserts the user row in Neon on first login ────────────────
		const users = api.root.addResource("users");
		users.addResource("me").addMethod("POST", workoutsInt, protected_);

		// ── /exercises (public) ───────────────────────────────────────────────────
		const exercises = api.root.addResource("exercises");
		exercises.addMethod("GET", workoutsInt);
		exercises.addResource("{exerciseId}").addMethod("GET", workoutsInt);

		// ── /workouts ─────────────────────────────────────────────────────────────
		const workouts = api.root.addResource("workouts");
		workouts.addMethod("GET", workoutsInt, protected_);
		workouts.addMethod("POST", workoutsInt, protected_);

		const workoutById = workouts.addResource("{workoutId}");
		workoutById.addMethod("GET", workoutsInt, protected_);
		workoutById.addMethod("PATCH", workoutsInt, protected_);
		workoutById.addMethod("DELETE", workoutsInt, protected_);

		// ── /workouts/{workoutId}/exercises ───────────────────────────────────────
		const weList = workoutById.addResource("exercises");
		weList.addMethod("POST", workoutsInt, protected_);

		const weById = weList.addResource("{weId}");
		weById.addMethod("PATCH", workoutsInt, protected_);
		weById.addMethod("DELETE", workoutsInt, protected_);

		// ── /workouts/{workoutId}/exercises/{weId}/entries ────────────────────────
		const entries = weById.addResource("entries");
		entries.addMethod("POST", workoutsInt, protected_);

		const entryById = entries.addResource("{entryId}");
		entryById.addMethod("PATCH", workoutsInt, protected_);
		entryById.addMethod("DELETE", workoutsInt, protected_);

		// ── /workouts/{workoutId}/exercises/{weId}/routes ─────────────────────────
		const routes = weById.addResource("routes");
		routes.addMethod("POST", workoutsInt, protected_);

		const routeById = routes.addResource("{routeId}");
		routeById.addMethod("PATCH", workoutsInt, protected_);
		routeById.addMethod("DELETE", workoutsInt, protected_);

		// ── /stats ────────────────────────────────────────────────────────────────
		const stats = api.root.addResource("stats");

		stats.addResource("summary").addMethod("GET", statsInt, protected_);
		stats.addResource("frequency").addMethod("GET", statsInt, protected_);

		const statsExercises = stats.addResource("exercises");
		statsExercises.addResource("{exerciseId}").addMethod("GET", statsInt, protected_);

		// ── Outputs ───────────────────────────────────────────────────────────────
		new cdk.CfnOutput(this, "ApiUrl", {
			value: api.url,
			description: "Base URL — prefix all API calls with this",
			exportName: "WorkoutApiUrl",
		});
	}
}
