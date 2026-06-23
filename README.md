# 🔥 Roast My Build (CI Fitness Test)

A plug-and-play GitHub Action that performs a fun, gamified, and snarky audit of a developer's repository build pipeline. It audits **Determinism (Reproducibility)**, **Flab Factor (Bloat)**, and **Caching Efficiency** to keep pipelines fast, predictable, and optimized.

---

## Installation

Add the following step directly beneath your existing build step in your GitHub Actions workflow file:

```yaml
      - name: Build Application
        run: npm run build

      - name: Roast My Build
        uses: aaronbronow/roast-my-build@v0.1.0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## How It Works

It runs a read-only step after your existing build step that analyzes logs and runs a silent build to compare the output.

1. **Standard Build**: Runs your build command to generate a reference set of outputs.
2. **Mutated Build**: Restores the workspace, waiting 2 seconds and shifting the system locale (to `fr_FR.UTF-8`) and timezone (to `Pacific/Honolulu`) before running the build a second time.
3. **Fitness Audit**: Compares build outputs, extracts diffs of volatile files, scans the package lockfile for duplicate dependencies, and searches for hardcoded workspace paths leaking into production bundles.

---

## Configuration Options

| Input | Description | Default |
| :--- | :--- | :---: |
| `build-command` | The build command to run (e.g. `npm run build`). If omitted, the action auto-detects the command of the preceding workflow step. | *(Auto-detect)* |
| `github-token` | The secret `GITHUB_TOKEN` (e.g. `${{ secrets.GITHUB_TOKEN }}`). Required for PR Comments. | `""` |
| `pr-comment` | If set to `false`, disables posting comments to the PR (only writes to step summaries). | `true` |

---

## Contribute

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

<sub>Built with ❤️ by [Aaron Bronow](https://github.com/aaronbronow)</sub>
