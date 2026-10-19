# Changelog

## 0.1.0 (2026-10-19)

First release. Wave 1, package 1 of the 100-packages plan.

- `shipcheck check owner/repo [version]`: full release verification across git tag,
  tag commit resolution, package.json at the tag, GitHub release, npm version and
  latest, MCP Registry version and latest, and GHCR image tags. One GO or NO-GO
  verdict, exit code 0 or 1, with expected vs actual evidence per surface.
- `shipcheck npm @scope/pkg [version]` and `shipcheck registry io.github.Owner/repo [version]`
  for single-surface checks.
- MCP server with `check_release`, `check_npm`, and `check_registry` tools.
- Registry and GHCR surfaces report SKIP (not FAIL) when they do not apply to a repo.
  The tag-commit check exists because a real release once shipped with a tag pointing
  at a commit that did not exist; every other surface had looked fine.
