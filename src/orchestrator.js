const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { analyzeBuilds, renderPRComment } = require('./analyzer');
const https = require('https');

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.github']);

/**
 * Scan directory recursively to get relative file paths, sizes, and mtimes.
 * @param {string} dir 
 * @param {string} baseDir 
 * @returns {Map<string, {size: number, mtime: number}>}
 */
function scanWorkspace(dir, baseDir = dir) {
  const fileMap = new Map();
  if (!fs.existsSync(dir)) return fileMap;

  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (EXCLUDE_DIRS.has(file)) continue;

    const absolutePath = path.join(dir, file);
    const relativePath = path.relative(baseDir, absolutePath);
    const stat = fs.statSync(absolutePath);

    if (stat.isDirectory()) {
      const subMap = scanWorkspace(absolutePath, baseDir);
      for (const [key, val] of subMap.entries()) {
        fileMap.set(key, val);
      }
    } else {
      fileMap.set(relativePath, {
        size: stat.size,
        mtime: stat.mtimeMs
      });
    }
  }
  return fileMap;
}

/**
 * Identify files created or modified by comparing two workspace scans.
 * @param {Map<string, {size: number, mtime: number}>} before 
 * @param {Map<string, {size: number, mtime: number}>} after 
 * @returns {Array<string>} list of changed file relative paths
 */
function getChangedFiles(before, after) {
  const changed = [];
  for (const [relPath, afterMeta] of after.entries()) {
    const beforeMeta = before.get(relPath);
    if (!beforeMeta || beforeMeta.size !== afterMeta.size || beforeMeta.mtime !== afterMeta.mtime) {
      changed.push(relPath);
    }
  }
  return changed;
}

/**
 * Copy a list of files from source to target directory, preserving folder structure.
 */
function copyFiles(fileList, sourceDir, targetDir) {
  for (const relPath of fileList) {
    const src = path.join(sourceDir, relPath);
    const dest = path.join(targetDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.copyFileSync(src, dest);
    } catch (e) {
      console.warn(`Failed to copy ${relPath}: ${e.message}`);
    }
  }
}

/**
 * Delete a list of files and clean up empty parent directories.
 */
function deleteFiles(fileList, baseDir) {
  for (const relPath of fileList) {
    const filePath = path.join(baseDir, relPath);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        // Recursively remove parent directories if they become empty
        let dir = path.dirname(filePath);
        while (dir !== baseDir) {
          if (fs.readdirSync(dir).length === 0) {
            fs.rmdirSync(dir);
            dir = path.dirname(dir);
          } else {
            break;
          }
        }
      } catch (e) {
        // Ignore deletion errors
      }
    }
  }
}

/**
 * Search workflows for the step before our action to extract the build command.
 */
function findPrecedingStepCommand(workspaceDir) {
  const workflowsDir = path.join(workspaceDir, '.github', 'workflows');
  if (!fs.existsSync(workflowsDir)) return null;

  try {
    const files = fs.readdirSync(workflowsDir);
    for (const file of files) {
      if (file.endsWith('.yml') || file.endsWith('.yaml')) {
        const filePath = path.join(workflowsDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        if (content.includes('ci-roast') || content.includes('roast-my-build')) {
          // Parse lines to locate the run block preceding our uses action
          const lines = content.split('\n');
          let steps = [];
          let currentStep = null;
          let inSteps = false;
          let runBlockLines = [];
          let inRunBlock = false;
          let runBlockIndent = 0;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            const indent = line.length - line.trimStart().length;

            if (inRunBlock) {
              if (trimmed === '' || indent > runBlockIndent) {
                runBlockLines.push(line.slice(runBlockIndent));
                continue;
              } else {
                currentStep.run = runBlockLines.join('\n').trim();
                runBlockLines = [];
                inRunBlock = false;
              }
            }

            if (trimmed.startsWith('steps:')) {
              inSteps = true;
              continue;
            }

            if (inSteps && trimmed !== '' && !line.startsWith(' ') && !line.startsWith('-')) {
              inSteps = false;
            }

            if (inSteps) {
              if (trimmed.startsWith('-')) {
                if (currentStep) steps.push(currentStep);
                currentStep = { uses: '', run: '', name: '' };
                const inline = trimmed.slice(1).trim();
                const colonIdx = inline.indexOf(':');
                if (colonIdx !== -1) {
                  const key = inline.slice(0, colonIdx).trim();
                  const val = inline.slice(colonIdx + 1).trim();
                  if (key === 'uses') currentStep.uses = val;
                  if (key === 'run') currentStep.run = val;
                  if (key === 'name') currentStep.name = val;
                }
              } else if (currentStep) {
                const parts = trimmed.split(':');
                const key = parts[0].trim();
                if (key === 'uses') {
                  currentStep.uses = parts.slice(1).join(':').trim();
                } else if (key === 'run') {
                  const rest = parts.slice(1).join(':').trim();
                  if (rest === '|' || rest === '>') {
                    inRunBlock = true;
                    runBlockIndent = indent + 2;
                  } else {
                    currentStep.run = rest;
                  }
                } else if (key === 'name') {
                  currentStep.name = parts.slice(1).join(':').trim();
                }
              }
            }
          }
          if (currentStep) steps.push(currentStep);

          for (let idx = 0; idx < steps.length; idx++) {
            const step = steps[idx];
            if (step.uses && (step.uses.includes('ci-roast') || step.uses.includes('roast-my-build') || step.uses === './' || step.uses.startsWith('./'))) {
              if (idx > 0 && steps[idx - 1].run) {
                return steps[idx - 1].run;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn(`Error scanning workflow files: ${e.message}`);
  }
  return null;
}

/**
 * Simple dependency-free HTTP helper to interact with GitHub API.
 */
function githubRequest(method, endpoint, token, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      port: 443,
      path: endpoint,
      method: method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'ci-roast-action',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body ? JSON.parse(body) : null);
        } else {
          reject(new Error(`GitHub API error: ${res.statusCode} ${body}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

/**
 * Post or update PR comment.
 */
async function postPRComment(markdown, token) {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath || !fs.existsSync(eventPath)) {
    console.log('Skipping PR Comment: GITHUB_EVENT_PATH not found.');
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY; // "owner/repo"
  if (!repo) {
    console.log('Skipping PR Comment: GITHUB_REPOSITORY not set.');
    return;
  }

  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    const prNumber = event.pull_request ? event.pull_request.number : null;
    if (!prNumber) {
      console.log('Skipping PR Comment: Event is not a pull request.');
      return;
    }

    console.log(`Locating comments on PR #${prNumber}...`);
    const listEndpoint = `/repos/${repo}/issues/${prNumber}/comments`;
    const comments = await githubRequest('GET', listEndpoint, token);
    
    // Find existing comment by ci-roast
    const existingComment = comments.find(c => c.body.includes('Generated by [ci-roast]') || c.body.includes('CI Fitness Roast'));

    if (existingComment) {
      console.log(`Updating existing comment (ID: ${existingComment.id})...`);
      const updateEndpoint = `/repos/${repo}/issues/comments/${existingComment.id}`;
      await githubRequest('PATCH', updateEndpoint, token, { body: markdown });
      console.log('Comment updated successfully.');
    } else {
      console.log('Posting new PR comment...');
      await githubRequest('POST', listEndpoint, token, { body: markdown });
      console.log('Comment posted successfully.');
    }
  } catch (error) {
    console.error(`Failed to post PR comment: ${error.message}`);
  }
}

/**
 * Main execution flow
 */
async function main() {
  const workspace = process.cwd();
  console.log(`Initializing CI Fitness Test inside: ${workspace}`);

  // 1. Determine build command
  let buildCmd = process.env.INPUT_BUILD_COMMAND || '';
  if (!buildCmd) {
    console.log('No build-command input specified. Attempting to auto-detect from workflow YAML...');
    buildCmd = findPrecedingStepCommand(workspace) || '';
  }

  if (!buildCmd) {
    console.error('❌ Error: Could not detect preceding build command.');
    console.error('Please specify the command explicitly via the build-command input:');
    console.error('  with:');
    console.error('    build-command: "npm run build"');
    process.exit(1);
  }

  console.log(`🚀 Build command resolved: "${buildCmd}"`);

  // Setup directories
  const build1Dir = '/tmp/ci-roast-build1';
  const build2Dir = '/tmp/ci-roast-build2';
  fs.rmSync(build1Dir, { recursive: true, force: true });
  fs.rmSync(build2Dir, { recursive: true, force: true });
  fs.mkdirSync(build1Dir, { recursive: true });
  fs.mkdirSync(build2Dir, { recursive: true });

  // 2. Scan workspace before Build 1
  console.log('Scanning workspace pre-build...');
  const preBuild1 = scanWorkspace(workspace);

  // 3. Execute Build 1 (Standard)
  console.log('Running standard Build 1...');
  execSync(buildCmd, { stdio: 'inherit', env: process.env });

  // 4. Scan workspace post-Build 1 to collect outputs
  const postBuild1 = scanWorkspace(workspace);
  const changed1 = getChangedFiles(preBuild1, postBuild1);
  console.log(`Captured ${changed1.length} build output file(s).`);

  if (changed1.length === 0) {
    console.warn('⚠️ Warning: No build outputs detected! Did the build command create any files?');
  }

  // Copy outputs to build1Dir
  copyFiles(changed1, workspace, build1Dir);

  // Clean up workspace back to pre-build state
  console.log('Cleaning workspace for Build 2...');
  deleteFiles(changed1, workspace);

  // 5. Execute Build 2 (Mutated)
  // Apply environment variations: LC_ALL, TZ, and 2-second sleep
  console.log('Running mutated Build 2 with induced variance...');
  
  const mutationEnv = {
    ...process.env,
    TZ: 'Pacific/Honolulu',
    LC_ALL: 'fr_FR.UTF-8',
    LANG: 'fr_FR.UTF-8'
  };

  console.log('Waiting 2 seconds to guarantee time shifts...');
  execSync('sleep 2');

  execSync(buildCmd, { stdio: 'inherit', env: mutationEnv });

  // 6. Scan workspace post-Build 2 to collect outputs
  const postBuild2 = scanWorkspace(workspace);
  const changed2 = getChangedFiles(preBuild1, postBuild2);
  console.log(`Captured ${changed2.length} build output file(s) for Build 2.`);

  // Copy outputs to build2Dir
  copyFiles(changed2, workspace, build2Dir);

  // Clean up Build 2 files from workspace
  console.log('Restoring workspace files...');
  deleteFiles(changed2, workspace);

  // 7. Perform build analysis
  console.log('Running analyzer comparison...');
  const report = analyzeBuilds(build1Dir, build2Dir, workspace);
  const markdown = renderPRComment(report);

  // Write local report files to workspace root
  const jsonReportPath = path.join(workspace, 'ci-roast-report.json');
  const mdReportPath = path.join(workspace, 'ci-roast-report.md');
  console.log(`Writing local reports to workspace: ${jsonReportPath} and ${mdReportPath}`);
  fs.writeFileSync(jsonReportPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdReportPath, markdown);

  // 8. Output Report to Summary / PR
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    console.log('Writing report to GitHub Step Summary...');
    fs.appendFileSync(summaryFile, markdown);
  } else {
    console.log('\n--- CI Roast Report Summary ---');
    console.log(markdown);
  }

  const token = process.env.INPUT_GITHUB_TOKEN;
  const isPRCommentEnabled = process.env.INPUT_PR_COMMENT !== 'false';
  if (token && isPRCommentEnabled) {
    await postPRComment(markdown, token);
  } else {
    console.log('Skipping PR Comment: GITHUB_TOKEN not supplied or pr-comment is disabled.');
  }

  console.log('🎉 CI Fitness Test complete!');
}

main().catch(err => {
  console.error(`Execution failed: ${err.message}`);
  process.exit(1);
});
