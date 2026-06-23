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

// 4. Deleted file
fs.writeFileSync(path.join(dir1, 'deleted.txt'), 'Goodbye.');

// 5. Added file
fs.writeFileSync(path.join(dir2, 'added.txt'), 'Welcome.');

// 6. Absolute path leak file (identical in both runs, but contains workspace path)
fs.writeFileSync(path.join(dir1, 'bundle-with-path.js'), `(function() { console.log("loading from ${tmpDir}/src/app.js"); })()`);
fs.writeFileSync(path.join(dir2, 'bundle-with-path.js'), `(function() { console.log("loading from ${tmpDir}/src/app.js"); })()`);

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

// Run analysis
console.log('Running build analysis...');
try {
  const report = analyzeBuilds(dir1, dir2, tmpDir);
  console.log('\n--- Numerical Scores ---');
  console.log(`Determinism: ${report.determinismScore} (${report.determinismGrade})`);
  console.log(`Flab: ${report.flabScore} (${report.flabGrade})`);
  console.log(`Caching: ${report.cacheScore} (${report.cacheGrade})`);
  console.log(`Duplicates Count: ${report.duplicatesCount}`);
  console.log(`Absolute Path Leaks: ${report.leakedPathsCount}`);
  
  console.log('\n--- Rendered Markdown Report ---');
  const markdown = renderPRComment(report);
  console.log(markdown);
} catch (error) {
  console.error('Test execution failed:', error);
} finally {
  console.log('\nCleaning up mock folders...');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
