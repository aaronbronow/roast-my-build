const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

/**
 * Checks if a file is binary by searching for null bytes in the first 8KB.
 * Also checks file size and extensions.
 * @param {string} filePath 
 * @returns {boolean}
 */
function isBinaryFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return false;
    
    // Files larger than 5MB are treated as binary to prevent diff blowup
    if (stat.size > 5 * 1024 * 1024) return true;
    
    // Explicit binary extensions check
    const ext = path.extname(filePath).toLowerCase();
    const binaryExtensions = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz',
      '.tar', '.tgz', '.mp3', '.mp4', '.wav', '.woff', '.woff2', '.eot', '.ttf'
    ]);
    if (binaryExtensions.has(ext)) return true;

    // Read first 8KB to check for null bytes
    const buffer = Buffer.alloc(Math.min(stat.size, 8192));
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Computes SHA-256 hash of a file.
 * @param {string} filePath 
 * @returns {string}
 */
function getFileHash(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > 50 * 1024 * 1024) {
    // Skip hashing very large files, just return size
    return `size-${stat.size}`;
  }
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Recursively list all files in a directory, ignoring node_modules, .git, etc.
 * @param {string} dir 
 * @param {string} baseDir 
 * @returns {Object} map of relative path -> { absolutePath, size, isBinary }
 */
function listAllFiles(dir, baseDir = dir) {
  let results = {};
  if (!fs.existsSync(dir)) return results;
  
  const list = fs.readdirSync(dir);
  for (const file of list) {
    if (file === 'node_modules' || file === '.git' || file === '.github') continue;
    
    const absolutePath = path.join(dir, file);
    const relativePath = path.relative(baseDir, absolutePath);
    const stat = fs.statSync(absolutePath);
    
    if (stat.isDirectory()) {
      Object.assign(results, listAllFiles(absolutePath, baseDir));
    } else {
      results[relativePath] = {
        absolutePath,
        size: stat.size,
        isBinary: isBinaryFile(absolutePath)
      };
    }
  }
  return results;
}

/**
 * Formats byte size into human readable string.
 * @param {number} bytes 
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Generates diff between two files using system diff command, falling back to basic info.
 * @param {string} file1 
 * @param {string} file2 
 * @returns {string}
 */
function generateDiff(file1, file2) {
  try {
    const diff = execSync(`diff -u --strip-trailing-cr "${file1}" "${file2}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024 // 10MB
    });
    return diff;
  } catch (error) {
    if (error.stdout) {
      return error.stdout;
    }
    return `Error generating diff: ${error.message}`;
  }
}

/**
 * Truncate diff block to stay within length restrictions.
 * @param {string} diffText 
 * @param {number} maxLines 
 * @param {number} maxChars 
 * @returns {string}
 */
function truncateDiff(diffText, maxLines = 40, maxChars = 2000) {
  const lines = diffText.split('\n');
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines).join('\n') + `\n\n... (diff truncated: ${lines.length - maxLines} lines omitted) ...`;
  }
  if (diffText.length > maxChars) {
    return diffText.slice(0, maxChars) + `\n\n... (diff truncated: character limit reached) ...`;
  }
  return diffText;
}

/**
 * Scan package-lock.json to find duplicates.
 * @param {string} workspaceDir 
 * @returns {Object} { duplicates, totalDeps }
 */
function analyzeLockfile(workspaceDir) {
  const lockfilePath = path.join(workspaceDir, 'package-lock.json');
  const duplicates = {};
  const packageVersions = {};
  
  if (!fs.existsSync(lockfilePath)) {
    return { duplicates, totalDeps: 0, present: false };
  }
  
  try {
    const lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
    if (lock.packages) {
      for (const [key, pkg] of Object.entries(lock.packages)) {
        if (key === "") continue;
        const name = key.replace(/^(.*node_modules\/)/, "");
        if (!name || !pkg.version) continue;
        
        if (!packageVersions[name]) {
          packageVersions[name] = new Set();
        }
        packageVersions[name].add(pkg.version);
      }
    } else if (lock.dependencies) {
      const traverse = (deps) => {
        for (const [name, dep] of Object.entries(deps)) {
          if (!packageVersions[name]) {
            packageVersions[name] = new Set();
          }
          packageVersions[name].add(dep.version);
          if (dep.dependencies) {
            traverse(dep.dependencies);
          }
        }
      };
      traverse(lock.dependencies);
    }
    
    let totalDeps = 0;
    for (const [name, versions] of Object.entries(packageVersions)) {
      totalDeps += versions.size;
      if (versions.size > 1) {
        duplicates[name] = Array.from(versions);
      }
    }
    
    return { duplicates, totalDeps, present: true };
  } catch (error) {
    return { error: error.message, duplicates, totalDeps: 0, present: true };
  }
}

/**
 * Scan workflow files for caching options.
 * @param {string} workspaceDir 
 * @returns {boolean}
 */
function detectWorkflowCaching(workspaceDir) {
  const workflowsDir = path.join(workspaceDir, '.github', 'workflows');
  if (!fs.existsSync(workflowsDir)) return false;
  
  try {
    const files = fs.readdirSync(workflowsDir);
    for (const file of files) {
      if (file.endsWith('.yml') || file.endsWith('.yaml')) {
        const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
        if (content.includes('actions/cache') || content.includes('cache:') || content.includes('cache-dependency-path')) {
          return true;
        }
      }
    }
  } catch (e) {
    // Ignore error
  }
  return false;
}

/**
 * Check build output files for absolute workspace path leakages.
 * @param {string} dir 
 * @param {string} workspaceDir 
 * @returns {Array<string>} list of relative paths containing leaks
 */
function checkForAbsolutePaths(dir, workspaceDir) {
  const files = listAllFiles(dir);
  const leakedFiles = [];
  for (const [relPath, info] of Object.entries(files)) {
    if (info.isBinary) continue;
    try {
      const content = fs.readFileSync(info.absolutePath, 'utf8');
      if (content.includes(workspaceDir)) {
        leakedFiles.push(relPath);
      }
    } catch (e) {
      // Ignore file read errors
    }
  }
  return leakedFiles;
}

/**
 * Scan files in directory for leaked secrets.
 */
const SECRETS_RULES = [
  { name: 'Google API Key', regex: /AIzaSy[A-Za-z0-9-_]{30,40}/g },
  { name: 'AWS Key ID', regex: /AKIA[0-9A-Z]{16}/g },
  { name: 'GitHub Personal Token', regex: /gh[op]_[a-zA-Z0-9]{36,255}/g },
  { name: 'Slack Webhook URL', regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9_]+\/B[A-Z0-9_]+\/[A-Za-z0-9_]+/g },
  { name: 'Generic Secret Variable', regex: /(?:api_key|apikey|secret_key|private_key|db_password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{16,}["']/gi }
];

function scanForSecrets(dir) {
  const files = listAllFiles(dir);
  const leaked = [];
  for (const [relPath, info] of Object.entries(files)) {
    if (info.isBinary) continue;
    try {
      const content = fs.readFileSync(info.absolutePath, 'utf8');
      for (const rule of SECRETS_RULES) {
        const matches = content.match(rule.regex);
        if (matches) {
          leaked.push({
            file: relPath,
            type: rule.name,
            matches: Array.from(new Set(matches)).map(m => m.slice(0, 8) + '***') // Obfuscate secrets in report
          });
        }
      }
    } catch (e) {
      // Ignore errors
    }
  }
  return leaked;
}

/**
 * Scan stdout logs for build compilation warning counts.
 */
function countWarnings(buildLog) {
  if (!buildLog) return 0;
  const lines = buildLog.split('\n');
  let count = 0;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('warning') || lower.includes('warn:') || lower.includes('warn ') || lower.includes('deprecation')) {
      count++;
    }
  }
  return count;
}

const LLM_PROVIDERS = [
  { name: 'OpenAI', envs: ['OPENAI_API_KEY'], keywords: ['api.openai.com', 'gpt-4', 'gpt-3.5', 'chatgpt'] },
  { name: 'Gemini', envs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], keywords: ['generativelanguage.googleapis.com', 'gemini-1.5', 'gemini-pro'] },
  { name: 'Anthropic', envs: ['ANTHROPIC_API_KEY'], keywords: ['api.anthropic.com', 'claude-3', 'claude-'] },
  { name: 'Cohere', envs: ['COHERE_API_KEY'], keywords: ['api.cohere.ai', 'cohere.ai'] },
  { name: 'Ollama', envs: ['OLLAMA_HOST'], keywords: ['localhost:11434', 'ollama'] },
  { name: 'Groq', envs: ['GROQ_API_KEY'], keywords: ['api.groq.com', 'groq-'] },
  { name: 'Mistral', envs: ['MISTRAL_API_KEY'], keywords: ['api.mistral.ai', 'mistral.ai'] },
  { name: 'DeepSeek', envs: ['DEEPSEEK_API_KEY'], keywords: ['api.deepseek.com', 'deepseek-'] },
  { name: 'Perplexity', envs: ['PERPLEXITY_API_KEY'], keywords: ['api.perplexity.ai', 'perplexity'] },
  { name: 'HuggingFace', envs: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'], keywords: ['api-infer.huggingface.co', 'huggingface.co/api'] }
];

function checkOracleConsultation(buildLog, env = {}) {
  const consulted = [];
  for (const provider of LLM_PROVIDERS) {
    const envDetected = provider.envs.some(key => env[key] !== undefined && env[key] !== '');
    const logDetected = buildLog && provider.keywords.some(kw => buildLog.toLowerCase().includes(kw.toLowerCase()));
    if (envDetected || logDetected) {
      consulted.push(provider.name);
    }
  }
  return consulted;
}

function checkRunnerStaleness(env = {}, workspaceDir = '') {
  const result = {
    imageAgeDays: null,
    isStale: false,
    imageDateStr: '',
    pinningStatus: 'Unknown',
    pinningDetails: 'Unable to scan workflow files.'
  };

  // 1. Calculate age from ImageVersion (format: YYYYMMDD.N.R)
  const imageVersion = env.ImageVersion || '';
  if (imageVersion) {
    const match = imageVersion.match(/^(\d{4})(\d{2})(\d{2})/);
    if (match) {
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const day = parseInt(match[3], 10);
      const imageDate = new Date(year, month, day);
      const currentDate = new Date();
      const diffMs = currentDate.getTime() - imageDate.getTime();
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      
      result.imageAgeDays = diffDays;
      result.imageDateStr = `${year}-${match[2]}-${match[3]}`;
      
      // Consider a runner image stale if it is older than 180 days (6 months)
      if (diffDays > 180) {
        result.isStale = true;
      }
    }
  }

  // 2. Scan workflow files for floating runner versions and unpinned container tags
  try {
    const workflowsDir = path.join(workspaceDir, '.github', 'workflows');
    if (fs.existsSync(workflowsDir)) {
      const files = fs.readdirSync(workflowsDir);
      let foundUnpinnedLatest = false;
      let foundRunsOnLatest = false;
      let foundContainerTag = false;
      
      for (const file of files) {
        if (file.endsWith('.yml') || file.endsWith('.yaml')) {
          const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
          
          if (/runs-on:\s*['"]?[a-zA-Z0-9_-]+-latest['"]?/i.test(content)) {
            foundRunsOnLatest = true;
          }
          
          const containerMatches = content.match(/container:\s*(?:image:\s*)?['"]?([^\s'"]+)['"]?/gi);
          if (containerMatches) {
            for (const matchStr of containerMatches) {
              const parts = matchStr.split(':');
              const imageName = parts.slice(1).join(':').trim();
              if (imageName.endsWith('latest') || (!imageName.includes(':') && !imageName.includes('@'))) {
                foundUnpinnedLatest = true;
              } else {
                foundContainerTag = true;
              }
            }
          }
        }
      }

      if (foundUnpinnedLatest) {
        result.pinningStatus = '❌ Unpinned Container';
        result.pinningDetails = 'Workflow uses mutable container tags (e.g. ":latest"), which degrades reproducibility.';
      } else if (foundRunsOnLatest) {
        result.pinningStatus = '⚠️ Floating Runner';
        result.pinningDetails = 'Workflow runs on floating runner tags (e.g. "ubuntu-latest"). High risk of unexpected compiler shifts.';
      } else {
        result.pinningStatus = '🟢 Pinned';
        result.pinningDetails = 'Workflow runner/container image references are pinned to specific versions.';
      }
    }
  } catch (e) {
    // Ignore workflow scanning errors
  }

  return result;
}

function detectRunnerEnvironment(env = {}, workspaceDir = '') {
  const staleness = checkRunnerStaleness(env, workspaceDir);

  if (!env.GITHUB_ACTIONS) {
    return {
      type: 'Local Workstation',
      details: 'Executed outside of GitHub Actions environment.',
      status: '🟢 Local',
      staleness
    };
  }

  const isSelfHosted = env.RUNNER_ENVIRONMENT === 'self-hosted' || 
                       (env.RUNNER_NAME && env.RUNNER_NAME.toLowerCase().includes('self'));
  
  let hasDockerEnv = false;
  try {
    hasDockerEnv = fs.existsSync('/.dockerenv') || 
                   (fs.existsSync('/proc/1/cgroup') && fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'));
  } catch (e) {
    // Ignore proc reading permission errors
  }

  const imageOS = env.ImageOS || '';
  const imageVersion = env.ImageVersion || '';
  
  let detailSuffix = '';
  if (staleness.imageAgeDays !== null) {
    detailSuffix += ` Image age: ${staleness.imageAgeDays} days (${staleness.isStale ? '⚠️ Stale' : '🟢 Fresh'}).`;
  }
  if (staleness.pinningStatus !== 'Unknown') {
    detailSuffix += ` Pinning: ${staleness.pinningStatus}.`;
  }
  
  if (isSelfHosted) {
    return {
      type: 'Self-Hosted Runner',
      details: `Custom runner (${env.RUNNER_NAME || 'Unnamed'}). Prone to persistent state caching.${detailSuffix}`,
      status: '⚠️ Self-Hosted',
      staleness
    };
  }

  if (imageOS && imageVersion) {
    return {
      type: `GitHub-Hosted (${imageOS})`,
      details: `Standard GitHub runner image (v${imageVersion}) with pre-installed tools.${detailSuffix}`,
      status: staleness.isStale ? '⚠️ Stale Image' : '🟢 GitHub-Hosted',
      staleness
    };
  }

  if (hasDockerEnv) {
    let containerType = 'Docker Hardened Container';
    let details = 'Isolated, clean, reproducible container environment.';
    
    try {
      if (fs.existsSync('/etc/os-release')) {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf8').toLowerCase();
        if (osRelease.includes('alpine')) {
          containerType = 'Alpine Container';
          details = 'Ultra-lean Alpine Linux container. Zero pre-installed tooling bloat.';
        } else if (osRelease.includes('ubuntu')) {
          containerType = 'Ubuntu Container';
          details = 'Clean Ubuntu containerized workspace.';
        } else if (osRelease.includes('debian')) {
          containerType = 'Debian Container';
          details = 'Clean Debian containerized workspace.';
        }
      }
    } catch (e) {
      // Ignore reading os-release errors
    }
    return {
      type: containerType,
      details: `${details}${detailSuffix}`,
      status: staleness.isStale ? '⚠️ Stale Container' : '🟢 Hardened',
      staleness
    };
  }

  return {
    type: 'Generic Runner',
    details: `Generic runner running on ${env.RUNNER_OS || 'Unknown OS'} (${env.RUNNER_ARCH || 'Unknown Arch'}).${detailSuffix}`,
    status: '🟢 Generic',
    staleness
  };
}

/**
 * Map numerical score to letter grade.
 * @param {number} score 
 * @returns {string}
 */
function getGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * Generate a witty roast based on scores and findings.
 * @param {Object} results 
 * @returns {string}
 */
function getWittyRoast(results) {
  const { 
    determinismGrade, flabGrade, cacheGrade, 
    duplicatesCount, sourcemapsFound, hasCaching, 
    leakedPathsCount, leakedSecretsCount, warningCount, 
    lockfileMutated, jitterPercent, giantAssetsCount,
    consultedLLMsCount
  } = results;
  
  const determinismRoasts = {
    'A': "Your build is as stable as bedrock. No variance, no secrets. Borrring.",
    'B': "Almost deterministic, but some digital ghost is whispering timestamps or absolute paths into your assets.",
    'C': "Your build changes more often than a toddler's mood. A few files are leaking local state between runs.",
    'D': "We mutated your environment and your build fell apart. CDNs will cache nothing.",
    'F': "Determinism? More like dice-roll-ism. Your build is completely volatile. Are you compile-dating each file?"
  };

  const flabRoasts = {
    'A': "Clean, light, and optimized. Did you forget to install dependencies or are you just good?",
    'B': "Reasonably trim, but there's a little winter weight here.",
    'C': "Your build outputs look like they visited a buffet. Duplicate dependencies and bloated assets.",
    'D': "Your production bundles are thicker than a dictionary. Your users are downloading half of NPM.",
    'F': "An absolute unit. Total flab. Lockfile duplication is out of control, giant unoptimized assets everywhere, and you are shipping sourcemaps."
  };

  const cacheRoasts = {
    'A': "Caching configuration is top-tier. Zooming past installation phases.",
    'B': "Decent workflow cache, but could shave off a few more seconds.",
    'C': "You're caching, but you could cache smarter.",
    'D': "Workflow has zero caching configured. You are installing npm packages from scratch on every run. Greenpeace is crying.",
    'F': "No caching, slow builds, and complete resource waste. Think of the carbon footprint!"
  };

  let specificPunches = [];
  if (sourcemapsFound) {
    specificPunches.push("Shipping production sourcemaps is basically publishing your git repo as a static website.");
  }
  if (duplicatesCount > 15) {
    specificPunches.push(`You have ${duplicatesCount} duplicate packages. Your lockfile looks like a cloning facility gone wrong.`);
  }
  if (!hasCaching) {
    specificPunches.push("Setting up action caching takes 2 lines of YAML. Please save the servers.");
  }
  if (leakedPathsCount > 0) {
    specificPunches.push(`Baking absolute workspace paths (${leakedPathsCount} files) into assets makes your build leaks stickier than wet paint.`);
  }
  if (leakedSecretsCount > 0) {
    specificPunches.push(`Leaking ${leakedSecretsCount} credentials directly in your production bundle. Thanks for the API keys, the bots will put them to good use!`);
  }
  if (warningCount > 100) {
    specificPunches.push(`Your build outputs ${warningCount} warnings. Your console log is a scroll of warning text taller than the Eiffel Tower.`);
  }
  if (lockfileMutated) {
    specificPunches.push("Your build step mutated package-lock.json. Installing dependencies at compile time? That's a pipeline crime.");
  }
  if (giantAssetsCount > 0) {
    specificPunches.push(`You have ${giantAssetsCount} giant uncompressed media assets. Your users' data plans are crying.`);
  }
  if (consultedLLMsCount > 0) {
    specificPunches.push(`Consulting the Oracle during compilation? What happens when Gemini starts hallucinating your CSS layout or OpenAI goes down mid-pipeline?`);
  }

  const baseRoast = `${determinismRoasts[determinismGrade]} ${flabRoasts[flabGrade]} ${cacheRoasts[cacheGrade]}`;
  const punchline = specificPunches.length > 0 ? `\n\n**Special Roast:** ${specificPunches.join(" ")}` : "";
  
  return `### 💬 The Roast\n> "${baseRoast}"${punchline}`;
}

/**
 * Compare two directories and return metrics, differences, and grades.
 * @param {string} dir1 Standard build directory
 * @param {string} dir2 Mutated build directory
 * @param {string} workspaceDir Original project root for lockfile checks etc.
 * @param {Object} rawParams Extra parameters captured during runtime (durations, logs, etc.)
 * @returns {Object} Complete report data
 */
function analyzeBuilds(dir1, dir2, workspaceDir, rawParams = {}) {
  const { duration1 = 0, duration2 = 0, buildLog = '', lockfileMutated = false } = rawParams;
  
  const files1 = listAllFiles(dir1);
  const files2 = listAllFiles(dir2);
  
  const results = {
    added: [],
    removed: [],
    modified: [],
    identical: [],
    totalSize1: 0,
    totalSize2: 0,
    fileCount1: 0,
    fileCount2: 0,
    sourcemapsFound: false
  };

  // Compute total size and file counts
  results.fileCount1 = Object.keys(files1).length;
  results.fileCount2 = Object.keys(files2).length;
  
  const giantAssets = [];
  const mediaExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.mp3', '.mp4', '.woff2']);

  for (const [relPath, info] of Object.entries(files1)) {
    results.totalSize1 += info.size;
    if (path.extname(relPath) === '.map') {
      results.sourcemapsFound = true;
    }
    const ext = path.extname(relPath).toLowerCase();
    if (mediaExtensions.has(ext) && info.size > 500 * 1024) { // > 500KB
      giantAssets.push({ path: relPath, size: info.size });
    }
  }
  for (const [relPath, info] of Object.entries(files2)) {
    results.totalSize2 += info.size;
  }

  // Compare files
  for (const [relPath, info1] of Object.entries(files1)) {
    const info2 = files2[relPath];
    if (!info2) {
      results.removed.push(relPath);
    } else {
      const hash1 = getFileHash(info1.absolutePath);
      const hash2 = getFileHash(info2.absolutePath);
      
      if (hash1 === hash2) {
        results.identical.push(relPath);
      } else {
        let diffContent = '';
        if (info1.isBinary || info2.isBinary) {
          diffContent = `Binary file changed. Size shifted from ${info1.size} bytes to ${info2.size} bytes.`;
        } else {
          diffContent = generateDiff(info1.absolutePath, info2.absolutePath);
        }
        
        results.modified.push({
          path: relPath,
          size1: info1.size,
          size2: info2.size,
          isBinary: info1.isBinary || info2.isBinary,
          diff: diffContent
        });
      }
    }
  }

  for (const relPath of Object.keys(files2)) {
    if (!files1[relPath]) {
      results.added.push(relPath);
    }
  }

  // Analyze package dependencies and other checks
  const lockfileReport = analyzeLockfile(workspaceDir);
  const hasCaching = detectWorkflowCaching(workspaceDir);
  const leakedPaths = checkForAbsolutePaths(dir1, workspaceDir);
  const leakedSecrets = scanForSecrets(dir1);
  const warningCount = countWarnings(buildLog);
  const buildEnv = rawParams.buildEnv || {};
  const consultedLLMs = checkOracleConsultation(buildLog, buildEnv);
  const runnerEnv = detectRunnerEnvironment(buildEnv, workspaceDir);

  // Compute Build Speed Jitter
  const jitterMs = Math.abs(duration1 - duration2);
  const jitterPercent = duration1 > 0 ? parseFloat((jitterMs / duration1 * 100).toFixed(1)) : 0;

  // 1. Determinism Score Calculation
  // Standard start is 100. Subtract points based on modifications, leaks, secrets, and LLM calls.
  let determinismScore = 100;
  const varianceCount = results.modified.length + results.added.length + results.removed.length;
  determinismScore -= (varianceCount * 15); // penalize 15 points per volatile file
  determinismScore -= (leakedPaths.length * 10); // penalize 10 points per leaked path file
  determinismScore -= (leakedSecrets.length * 20); // penalize 20 points per leaked credential file
  if (consultedLLMs.length > 0) {
    determinismScore -= 15; // penalize 15 points if they query LLMs during compile
  }
  if (determinismScore < 0) determinismScore = 0;
  const determinismGrade = getGrade(determinismScore);

  // 2. Flab Factor Score Calculation
  let flabScore = 100;
  const duplicatesCount = Object.keys(lockfileReport.duplicates).length;
  flabScore -= (duplicatesCount * 3); // 3 points per duplicate package
  if (results.totalSize1 > 50 * 1024 * 1024) {
    flabScore -= 30;
  } else if (results.totalSize1 > 10 * 1024 * 1024) {
    flabScore -= 15;
  }
  if (results.sourcemapsFound) {
    flabScore -= 15;
  }
  flabScore -= (giantAssets.length * 5); // 5 points per giant image
  if (flabScore < 0) flabScore = 0;
  const flabGrade = getGrade(flabScore);

  // 3. Caching Score Calculation
  const isTooFastToCache = duration1 < 2000;
  let cacheScore = (hasCaching || isTooFastToCache) ? 95 : 40;
  if (lockfileMutated) {
    cacheScore -= 25; // penalize 25 points for mutating package-lock
  }
  if (jitterPercent > 25 && duration1 > 10000) {
    cacheScore -= 15; // penalize 15 points if execution has high jitter
  }
  if (cacheScore < 0) cacheScore = 0;
  const cacheGrade = getGrade(cacheScore);

  return {
    metrics: results,
    lockfile: lockfileReport,
    hasCaching,
    leakedPaths,
    leakedPathsCount: leakedPaths.length,
    leakedSecrets,
    leakedSecretsCount: leakedSecrets.length,
    warningCount,
    duration1,
    duration2,
    jitterPercent,
    giantAssets,
    giantAssetsCount: giantAssets.length,
    lockfileMutated,
    consultedLLMs,
    consultedLLMsCount: consultedLLMs.length,
    runnerEnv,
    determinismScore,
    determinismGrade,
    flabScore,
    flabGrade,
    cacheScore,
    cacheGrade,
    duplicatesCount,
    sourcemapsFound: results.sourcemapsFound
  };
}

/**
 * Generate PR Comment Markdown Report
 */
function renderPRComment(report) {
  const {
    metrics,
    lockfile,
    leakedPaths,
    leakedSecrets,
    warningCount,
    duration1,
    duration2,
    jitterPercent,
    giantAssets,
    lockfileMutated,
    consultedLLMs,
    runnerEnv,
    determinismGrade,
    flabGrade,
    cacheGrade,
    duplicatesCount
  } = report;

  const totalSize = formatBytes(metrics.totalSize1);
  const varianceCount = metrics.modified.length + metrics.added.length + metrics.removed.length;
  let cacheDuration = duration1 < 1000 ? '< 1.0s' : `${(duration1 / 1000).toFixed(1)}s`;
  let reprodStatus = determinismGrade === 'A' ? '🟢 Sterile' : '⚠️ Volatile';
  let flabStatus = flabGrade === 'A' || flabGrade === 'B' ? '🟢 Lean' : '🍔 Plump';
  let cacheStatus = cacheGrade === 'A' || cacheGrade === 'B' ? '🟢 Active' : '🏃 Sluggish';

  const roast = getWittyRoast(report);

  let md = `## 🔥 Roast my Build: Scorecard\n\n`;
  md += `| Category | Grade | Status | Summary |\n`;
  md += `| :--- | :---: | :---: | :--- |\n`;
  md += `| **Reproducibility (Determinism)** | **${determinismGrade}** | ${reprodStatus} | ${varianceCount} volatile file(s) detected. |\n`;
  md += `| **Flab Factor (Bloat)** | **${flabGrade}** | ${flabStatus} | Output size: ${totalSize} (${metrics.fileCount1} files). |\n`;
  md += `| **Caching Efficiency** | **${cacheGrade}** | ${cacheStatus} | Base compile time: ${cacheDuration}. |\n\n`;
  
  md += `${roast}\n\n`;

  md += `### 🔍 Detailed Audit Checklist\n\n`;
  md += `| Audit Check | Status | Details |\n`;
  md += `| :--- | :---: | :--- |\n`;
  md += `| 🔄 **File Volatility** | ${varianceCount === 0 ? '🟢 Sterile' : '⚠️ Volatile'} | ${varianceCount === 0 ? '0 files changed between back-to-back compile runs.' : `${varianceCount} file(s) modified/added/removed between runs.`} |\n`;
  md += `| 📂 **Absolute Path Leakage** | ${leakedPaths.length === 0 ? '🟢 Clean' : '⚠️ Leaking'} | ${leakedPaths.length === 0 ? 'No absolute workspace paths found in bundles.' : `${leakedPaths.length} file(s) bake hardcoded workspace paths.`} |\n`;
  md += `| 🚨 **Credentials & Secrets** | ${leakedSecrets.length === 0 ? '🟢 Secure' : '🚨 Exposed'} | ${leakedSecrets.length === 0 ? 'No exposed API keys or secrets in assets.' : `Leaked ${leakedSecrets.length} API keys or secret tokens in assets!`} |\n`;
  md += `| 📦 **Duplicate Dependencies** | ${duplicatesCount === 0 ? '🟢 Consolidated' : '🍔 Bloated'} | ${duplicatesCount === 0 ? '0 duplicate package versions in lockfile.' : `Found ${duplicatesCount} duplicate package versions in lockfile.`} |\n`;
  md += `| 🖼️ **Giant Media Assets** | ${giantAssets.length === 0 ? '🟢 Optimized' : '🍔 Plump'} | ${giantAssets.length === 0 ? 'All media assets and images are under 500KB.' : `Found ${giantAssets.length} uncompressed assets exceeding 500KB.`} |\n`;
  md += `| ⚠️ **Compile-Time Warnings** | ${warningCount === 0 ? '🟢 Clean' : '⚠️ Warning'} | ${warningCount === 0 ? '0 warnings found in build compilation logs.' : `Build logs output ${warningCount} compiler warning(s).`} |\n`;
  md += `| 🔒 **Lockfile Mutations** | ${!lockfileMutated ? '🟢 Sterile' : '⚠️ Mutated'} | ${!lockfileMutated ? 'package-lock.json was not modified during compiling.' : 'package-lock.json was mutated during the build step!'} |\n`;
  let cachingStatus = '';
  let cachingDetails = '';
  if (report.hasCaching) {
    cachingStatus = '🟢 Cached';
    cachingDetails = 'Dependency caching active in workflow configurations.';
  } else if (duration1 < 2000) {
    cachingStatus = '🟢 Bypassed';
    cachingDetails = 'Caching not required (build is extremely fast: < 2.0s).';
  } else {
    cachingStatus = '❌ Uncached';
    cachingDetails = 'Workflow does not cache node_modules or dependency locks.';
  }
  md += `| 🏃 **Action Step Caching** | ${cachingStatus} | ${cachingDetails} |\n`;
  md += `| 🔮 **Consulting the Oracle** | ${consultedLLMs.length === 0 ? '🟢 Independent' : '⚠️ Consulted'} | ${consultedLLMs.length === 0 ? 'Build did not consult any known LLM APIs.' : `Queried LLM APIs (${consultedLLMs.join(', ')}) during compilation!`} |\n`;
  const runnerEnvObj = runnerEnv || { type: 'Unknown', details: 'Unable to detect runner type.', status: '⚠️ Unknown' };
  md += `| 🧬 **Runner Pedigree** | ${runnerEnvObj.status} | ${runnerEnvObj.type}: ${runnerEnvObj.details} |\n`;
  const speedStatus = (jitterPercent <= 25 || duration1 < 1000) ? '🟢 Stable' : '⚠️ Erratic';
  md += `| ⏱️ **Build Speed Stability** | ${speedStatus} | ${duration1 < 1000 ? 'Execution time is sub-second (no jitter measured).' : `Build variance is ${jitterPercent}% (Standard: ${(duration1/1000).toFixed(1)}s vs Shifted: ${(duration2/1000).toFixed(1)}s).`} |\n\n`;
  
  md += `### 📊 Diagnostics & Breakdown\n\n`;

  md += `#### ⏱️ Build & Logs Summary\n`;
  md += `* **Standard Build Time**: \`${(duration1 / 1000).toFixed(2)} seconds\`\n`;
  md += `* **Environment Shift Build Time**: \`${(duration2 / 1000).toFixed(2)} seconds\`\n`;
  md += `* **Speed Jitter**: \`${jitterPercent}%\` variance between runs.\n`;
  md += `* **Warnings Count**: \`${warningCount}\` compile-time warning(s) caught.\n\n`;

  if (metrics.modified.length > 0) {
    md += `#### 🌀 Non-Deterministic Files (Variance Detected)\n`;
    md += `These files changed when built twice under minor environment mutations:\n\n`;
    
    for (const file of metrics.modified.slice(0, 5)) {
      md += `##### \`${file.path}\` (${formatBytes(file.size1)} ──► ${formatBytes(file.size2)})\n`;
      if (file.isBinary) {
        md += `*Binary file changed.*\n\n`;
      } else {
        md += `\`\`\`diff\n`;
        md += truncateDiff(file.diff, 20, 1000) + `\n`;
        md += `\`\`\`\n\n`;
      }
    }
    if (metrics.modified.length > 5) {
      md += `*and ${metrics.modified.length - 5} more modified files.*\n\n`;
    }
  }

  if (leakedSecrets.length > 0) {
    md += `#### 🚨 Leaked Credentials & API Keys\n`;
    md += `We scanned your build output and found strings resembling secrets. Do not publish these assets:\n\n`;
    for (const leak of leakedSecrets.slice(0, 5)) {
      md += `* **File**: \`${leak.file}\` | **Type**: \`${leak.type}\` | **Found**: \`${leak.matches.join(', ')}\`\n`;
    }
    if (leakedSecrets.length > 5) {
      md += `*and ${leakedSecrets.length - 5} more leaked credentials.*\n\n`;
    }
  }

  if (leakedPaths.length > 0) {
    md += `#### 📂 Leaked Absolute Workspace Paths\n`;
    md += `These files contain references to your hardcoded local workspace directory (e.g. \`/home/runner/work...\`):\n\n`;
    for (const p of leakedPaths.slice(0, 8)) {
      md += `* \`${p}\`\n`;
    }
    if (leakedPaths.length > 8) {
      md += `*and ${leakedPaths.length - 8} more files.*\n\n`;
    }
  }

  if (giantAssets.length > 0) {
    md += `#### 🍔 Giant Media Assets (>500KB)\n`;
    md += `These assets should be compressed or converted to modern web formats to reduce network payload:\n\n`;
    for (const asset of giantAssets.slice(0, 8)) {
      md += `* \`${asset.path}\` (${formatBytes(asset.size)})\n`;
    }
    if (giantAssets.length > 8) {
      md += `*and ${giantAssets.length - 8} more giant assets.*\n\n`;
    }
  }

  if (lockfile.present && duplicatesCount > 0) {
    md += `#### 🍔 Lockfile Duplicates\n`;
    md += `We found duplicate installations of package versions in \`package-lock.json\`:\n\n`;
    const dupEntries = Object.entries(lockfile.duplicates).slice(0, 8);
    for (const [name, versions] of dupEntries) {
      md += `* \`${name}\`: versions ${versions.join(', ')}\n`;
    }
    if (Object.keys(lockfile.duplicates).length > 8) {
      md += `*and ${Object.keys(lockfile.duplicates).length - 8} more duplicate dependencies.*\n\n`;
    }
  }

  md += `#### 🛠️ Quick Wins to Fix This\n`;
  let wins = [];
  if (varianceCount > 0) {
    wins.push(`Freeze build times by setting the environment variable \`SOURCE_DATE_EPOCH\` or disabling timestamps in your build config.`);
  }
  if (leakedSecrets.length > 0) {
    wins.push(`Remove API keys and secrets from source code. Load them dynamically using environment configurations.`);
  }
  if (leakedPaths.length > 0) {
    wins.push(`Use relative pathing or replace \`__dirname\` references during bundling to prevent absolute path leakage.`);
  }
  if (giantAssets.length > 0) {
    wins.push(`Compress large media assets using imagemin, or convert them to WebP/AVIF formats.`);
  }
  if (report.sourcemapsFound) {
    wins.push(`Do not ship \`.map\` files to production build directories. Exclude them in your webpack/vite configuration.`);
  }
  if (lockfileMutated) {
    wins.push(`Do not run commands that modify dependencies (like \`npm install\` without \`--package-lock-only\` or \`npm build\` scripts that write back to files) during compiling.`);
  }
  if (duplicatesCount > 0) {
    wins.push(`Run \`npm dedupe\` to consolidate package versions in your lockfile.`);
  }
  if (!report.hasCaching) {
    wins.push(`Configure caching in your setup-node or cache actions to skip fetching node_modules on every run.`);
  }
  if (wins.length === 0) {
    wins.push(`Your build is in great shape! Keep up the clean work.`);
  }
  
  md += wins.map((w, idx) => `${idx + 1}. ${w}`).join('\n') + `\n\n`;
  md += `<sub>Generated by [Roast my Build](https://github.com/aaronbronow/roast-my-build) | Help us roast more builds by giving us a ⭐</sub>`;
  
  return md;
}

module.exports = {
  isBinaryFile,
  getFileHash,
  listAllFiles,
  analyzeBuilds,
  renderPRComment,
  checkForAbsolutePaths,
  scanForSecrets,
  countWarnings
};
