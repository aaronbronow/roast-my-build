const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { analyzeBuilds, renderPRComment } = require('./src/analyzer');

// Setup mock directories
const tmpDir = '/tmp/ci-roast-test';
const dir1 = path.join(tmpDir, 'build1');
const dir2 = path.join(tmpDir, 'build2');

console.log('Setting up mock build folders...');
fs.mkdirSync(dir1, { recursive: true });
fs.mkdirSync(dir2, { recursive: true });

// Setup mock workflows for checking version pinning
const workflowsDir = path.join(tmpDir, '.github', 'workflows');
fs.mkdirSync(workflowsDir, { recursive: true });
fs.writeFileSync(path.join(workflowsDir, 'ci.yml'), `
name: Build Pipeline
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    container:
      image: node:latest
`);

fs.writeFileSync(path.join(workflowsDir, 'vulnerable-pr.yml'), `
name: PR Builder
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Unsafe Code
        uses: actions/checkout@v4
        with:
          ref: \$\{\{ github.event.pull_request.head.sha \}\}
`);

fs.writeFileSync(path.join(workflowsDir, 'bypassed-pr.yml'), `
name: Bypassed PR Builder
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Unsafe Code
        uses: actions/checkout@v7
        with:
          ref: \$\{\{ github.event.pull_request.head.sha \}\}
          allow-unsafe-pr-checkout: true
`);

// 1. Identical text file
fs.writeFileSync(path.join(dir1, 'same.txt'), 'This file is identical.');
fs.writeFileSync(path.join(dir2, 'same.txt'), 'This file is identical.');

// 2. Modified text file (to trigger diff)
fs.writeFileSync(path.join(dir1, 'modified.txt'), 'Hello World\nLine 2\nLine 3\nTimestamp: 1782201000\nDone.');
fs.writeFileSync(path.join(dir2, 'modified.txt'), 'Hello World\nLine 2\nLine 3\nTimestamp: 1782201005\nDone.');

// 3. Binary file modified
const binBuffer1 = Buffer.from([1, 2, 3, 0, 5, 6]);
const binBuffer2 = Buffer.from([1, 2, 3, 0, 7, 8, 9]);
fs.writeFileSync(path.join(dir1, 'image.png'), binBuffer1);
fs.writeFileSync(path.join(dir2, 'image.png'), binBuffer2);

// 4. Absolute path leak file
fs.writeFileSync(path.join(dir1, 'bundle-with-path.js'), `(function() { console.log("loading from ${tmpDir}/src/app.js"); })()`);
fs.writeFileSync(path.join(dir2, 'bundle-with-path.js'), `(function() { console.log("loading from ${tmpDir}/src/app.js"); })()`);

// 5. Giant media asset (1MB size)
const giantBuffer = Buffer.alloc(1024 * 1024 * 1.2, 'a'); // 1.2MB unoptimized file
fs.writeFileSync(path.join(dir1, 'hero-background.png'), giantBuffer);
fs.writeFileSync(path.join(dir2, 'hero-background.png'), giantBuffer);

// 6. Secrets leak file
fs.writeFileSync(path.join(dir1, 'config.js'), `const config = { firebaseKey: "AIzaSyAz9-bX382947df-keySecretExample" };`);
fs.writeFileSync(path.join(dir2, 'config.js'), `const config = { firebaseKey: "AIzaSyAz9-bX382947df-keySecretExample" };`);

// 7. Mock package-lock.json with duplicates
const mockLock = {
  name: "mock-project",
  version: "1.0.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": {
      name: "mock-project",
      version: "1.0.0"
    },
    "node_modules/lodash": {
      version: "4.17.21"
    },
    "node_modules/babel-loader/node_modules/lodash": {
      version: "4.17.15"
    },
    "node_modules/kind-of": {
      version: "6.0.3"
    },
    "node_modules/some-lib/node_modules/kind-of": {
      version: "3.2.2"
    }
  }
};
fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify(mockLock, null, 2));

// Mock build params
const mockParams = {
  duration1: 4500,  // 4.5 seconds
  duration2: 6000,  // 6.0 seconds (33.3% jitter)
  lockfileMutated: true,
  buildEnv: {
    OPENAI_API_KEY: 'sk-proj-mock123key',
    GITHUB_ACTIONS: 'true',
    ImageVersion: '20240602.1.0',
    ImageOS: 'ubuntu22'
  },
  buildLog: `
    npm run build
    [vite:css] warning: "@import" statement after other declarations is ignored
    [vite:js] warning: deprecated option "output.format" was used
    [webpack] warning: DeprecationWarning: Tapable.plugin is deprecated.
  `
};

// Run analysis
console.log('Running build analysis...');
try {
  const report = analyzeBuilds(dir1, dir2, tmpDir, mockParams);
  console.log('\n--- Numerical Scores ---');
  console.log(`Determinism: ${report.determinismScore} (${report.determinismGrade})`);
  console.log(`Flab: ${report.flabScore} (${report.flabGrade})`);
  console.log(`Caching: ${report.cacheScore} (${report.cacheGrade})`);
  console.log(`Duplicates Count: ${report.duplicatesCount}`);
  console.log(`Absolute Path Leaks: ${report.leakedPathsCount}`);
  console.log(`Secrets Leaked Count: ${report.leakedSecretsCount}`);
  console.log(`Warnings Count: ${report.warningCount}`);
  console.log(`Giant Assets Count: ${report.giantAssetsCount}`);
  console.log(`Consulted LLMs: ${report.consultedLLMs.join(', ')}`);
  
  console.log('\n--- Rendered Markdown Report ---');
  const markdown = renderPRComment(report);
  console.log(markdown);
} catch (error) {
  console.error('Test execution failed:', error);
} finally {
  console.log('\nCleaning up mock folders...');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
