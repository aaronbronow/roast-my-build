# 🔥 Roast My Build (CI Fitness Test)

A plug-and-play GitHub Action that performs a fun, gamified, and snarky audit of a developer's repository build pipeline. It audits **Determinism (Reproducibility)**, **Flab Factor (Bloat)**, and **Caching Efficiency** to keep pipelines fast, predictable, and optimized.

---

## 🏋️ How It Works (The "Ghost Run")

Instead of relying on heavy static code analyzers, `ci-roast` **hijacks your existing CI build step** and tests it under stress:

1. **Standard Build**: Runs your build command to generate a reference set of outputs.
2. **Mutated Build**: Restores the workspace, waiting 2 seconds and shifting the system locale (to `fr_FR.UTF-8`) and timezone (to `Pacific/Honolulu`) before running the build a second time.
3. **Fitness Audit**: Compares build outputs, extracts diffs of volatile files, scans the package lockfile for duplicate dependencies, and searches for hardcoded workspace paths leaking into production bundles.

---

## 🚀 Integration Styles

Depending on how loud or private you want your feedback loop to be, choose one of these two onboarding routes:

### Option 1: The "PR Sidekick" (Continuous Feedback)

Append the step directly beneath your build command inside an active workflow. This will post (and continually update) a snarky dashboard directly in the PR timeline.

```yaml
      - name: Build Application
        run: npm run build --prod

      - name: 🔥 Roast My Build
        uses: the-yaml-company/ci-roast@v1
        if: github.event_name == 'pull_request'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Option 2: The "Weekend Sandbox" (Private Step Summary)

Run it manually or privately on-demand. This outputs the markdown dashboard straight to the native GitHub `$GITHUB_STEP_SUMMARY` page without writing public comments.

```yaml
name: "🏋️ CI Fitness Test (Manual Sandbox)"
on:
  workflow_dispatch: # Unlocks the "Run workflow" button in the GitHub UI

jobs:
  fitness-audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 'lts/*'
          cache: 'npm' # Caching enabled!
      - run: npm ci
      - name: Build Application
        run: npm run build

      - name: 🔥 Run Fitness Audit
        uses: the-yaml-company/ci-roast@v1
```

---

## ⚙️ Configuration Options

| Input | Description | Default |
| :--- | :--- | :---: |
| `build-command` | The build command to run (e.g. `npm run build`). If omitted, the action auto-detects the command of the preceding workflow step. | *(Auto-detect)* |
| `github-token` | The secret `GITHUB_TOKEN` (e.g. `${{ secrets.GITHUB_TOKEN }}`). Required for PR Comments. | `""` |
| `pr-comment` | If set to `false`, disables posting comments to the PR (only writes to step summaries). | `true` |

---

## 🛠️ Local Development & Testing

You can run the fitness test script locally on your workstation:

1. Clone the repository.
2. Setup two mock directories and run the test script:
   ```bash
   node test-run.js
   ```
3. Run the orchestrator with a mock build instruction to inspect its behavior:
   ```bash
   INPUT_BUILD_COMMAND="mkdir -p dist && echo 'hello' > dist/out.txt" node src/orchestrator.js
   ```

<sub>Built with ❤️ by [The YAML Company](https://github.com/the-yaml-company)</sub>
