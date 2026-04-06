
Note that the lambdas expect a parameter already existing like 

aws ssm put-parameter \
  --name "/workout/neon-connection-string" \
  --value "my-connection-string" \
  --type SecureString \
  --region eu-central-1


