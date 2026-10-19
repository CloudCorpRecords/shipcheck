# shipcheck

**Did that release actually ship? One command, every surface, one verdict.**

A modern release touches five public surfaces: the git tag, the GitHub release, npm, the MCP Registry, and the container image on GHCR. Each one can fail silently while the others look fine. The publish workflow goes green, and then: npm has the version stuck in a staged hold, the registry still points at the last release, the container tag never got pushed, or, the worst one, the git tag points at a commit that does not exist.

shipcheck checks every surface against one expected version and prints a single verdict: GO, or NO-GO with the exact surfaces that disagree and the evidence for each one.

## Why this exists

shipcheck was not designed in the abstract. It is the manual verification gauntlet from shipping [Greenlight](https://github.com/CloudCorpRecords/greenlight) and its sibling tools, turned into a tool. That gauntlet caught real failures:

- A release where the git tag pointed at a nonexistent commit object. npm, the registry, and the sources were all real; only checking that the tag resolves to a real commit exposed it. That is why `tag-commit` is a hard check.
- npm staged publishing holds, where a brand new package version sits in review and the registry shows only a placeholder. To a user, the release simply does not exist. That is why `npm-version` and `npm-latest` are separate checks.
- Registry publishes dispatched before npm verified, leaving the MCP Registry pointing at a version npm did not have yet. That ordering lesson is why shipcheck treats "listed" and "latest" as different facts on every surface.

## What it checks

| surface | what it proves |
| --- | --- |
| `git-tag` | Tag `v<version>` exists on the repo |
| `tag-commit` | The tag resolves to a real commit object |
| `tag-version` | `package.json` at the tag carries the expected version |
| `github-release` | A published (not draft) GitHub release exists for the tag |
| `npm-version` | The npm package has this version published |
| `npm-latest` | npm `dist-tags.latest` points at this version |
| `registry-version` | The MCP Registry lists this version for the server |
| `registry-latest` | The MCP Registry marks this version latest and active |
| `ghcr-tag` | The GHCR image has this version tag |
| `ghcr-latest` | The GHCR image also has a `latest` tag |

Verdict rules:

- **GO**: every hard check passes. Exit code 0.
- **NO-GO**: any hard check fails or errors. Exit code 1, ready for CI.
- **SKIP**: a surface that does not apply is skipped, never failed. A repo with no MCP Registry entry skips the registry checks; a repo with no public container image skips GHCR. GHCR checks are soft by default and become hard with `--require ghcr`.
- Every check reports expected vs actual and the source URL. A failed fetch is reported as an error with its HTTP status, never guessed.

## Usage

### CLI

```bash
# Full check. Version is read from package.json on the default branch.
npx @reneturcios/shipcheck check CloudCorpRecords/greenlight

# Check a specific version
npx @reneturcios/shipcheck check CloudCorpRecords/greenlight 0.15.1

# Machine readable output, custom surface names, force GHCR to be required
npx @reneturcios/shipcheck check owner/repo 1.2.0 --json \
  --npm @scope/pkg --server io.github.Owner/repo --require ghcr

# Single surfaces
npx @reneturcios/shipcheck npm @reneturcios/greenlight 0.15.1
npx @reneturcios/shipcheck registry io.github.CloudCorpRecords/greenlight 0.15.1
```

Example output:

```
shipcheck CloudCorpRecords/greenlight v0.15.1: GO
  [PASS] git-tag: Tag v0.15.1 exists (object type commit)
  [PASS] tag-commit: Tag resolves to real commit f52939005a0f
  [PASS] tag-version: package.json at v0.15.1 is version 0.15.1
  [PASS] github-release: GitHub release v0.15.1 is published
  [PASS] npm-version: @reneturcios/greenlight@0.15.1 is published on npm
  [PASS] npm-latest: npm latest points at 0.15.1
  [PASS] registry-version: MCP Registry lists io.github.CloudCorpRecords/greenlight 0.15.1 (status active)
  [PASS] registry-latest: MCP Registry latest is 0.15.1 and active
  [PASS] ghcr-tag: GHCR image has tag 0.15.1
  [PASS] ghcr-latest: GHCR image has a latest tag
GO: every hard surface agrees on this version.
```

Inference, so the common case needs one argument: the npm package name is read from `package.json` at the tag, the registry server name defaults to `io.github.<Owner>/<repo>`, and the GHCR image defaults to `ghcr.io/<owner>/<repo>` lowercased. Override any of them with `--npm`, `--server`, or `--ghcr`. Skip whole groups with `--skip npm,registry,ghcr,release,github`.

Set `GITHUB_TOKEN` for the higher authenticated GitHub API rate limit. Public surfaces need no other credentials; GHCR uses the standard anonymous token flow for public images.

### MCP server

Add to your MCP client config:

```json
{
  "mcpServers": {
    "shipcheck": {
      "command": "npx",
      "args": ["-y", "@reneturcios/shipcheck", "mcp"]
    }
  }
}
```

Tools:

- `check_release`: the full check: repo, optional version, optional npm/server overrides, require and skip lists.
- `check_npm`: one npm package and version: published, and latest points at it.
- `check_registry`: one MCP Registry server and version: listed, and marked latest.

### Docker

```bash
docker run -i ghcr.io/cloudcorprecords/shipcheck mcp
docker run --rm ghcr.io/cloudcorprecords/shipcheck check CloudCorpRecords/greenlight 0.15.1
```

## The toolkit

shipcheck is Wave 1, package 1 of a planned family of small, single-purpose developer tools by the same author, all built the same way: one bin that serves a CLI and an MCP server, deterministic checks with evidence, no invented answers.

- [greenlight](https://github.com/CloudCorpRecords/greenlight): pre-flight checks for open-source contributions: is this issue actually landable?
- [prwatch](https://github.com/CloudCorpRecords/prwatch): attention report for your open PRs: what needs you right now.
- [claimcheck](https://github.com/CloudCorpRecords/claimcheck): stale-claim states and parked fixes on forks.
- [gatefile](https://github.com/CloudCorpRecords/gatefile): extract hidden contribution gates into machine-readable contribution-gates.json.
- [pkgverdict](https://github.com/CloudCorpRecords/pkgverdict): pre-install verdicts for npm packages: GO, RISKY, FAKE, or MISSING.

## Development

```bash
npm install
npm run build
npm test   # 18 tests, all surface logic runs on injected fixtures, no network
```

## License

MIT
