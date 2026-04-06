import { APIGatewayProxyEvent } from "aws-lambda";

export function getUserSub(event: APIGatewayProxyEvent): string {
	const claims = event.requestContext?.authorizer?.claims;
	// ID token uses 'sub', same as access token — but also has cognito:username
	const sub = claims?.sub as string | undefined;

	if (!sub) {
		throw new Error(
			"Missing `sub` in authorizer claims — is this route protected in the CDK stack?"
		);
	}

	return sub;
}
