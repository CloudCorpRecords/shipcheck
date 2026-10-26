# Changelog

## 0.2.0 (2026-10-25)

Python-repo mode. shipcheck can now judge Python packages, not only npm ones.

- Ecosystem detection per repo: Node (package.json), Python (pyproject.toml,
  setup.py or setup.cfg, or a Python tag tree), or hybrid (both, like
  wallcheck, whose tag carries pyproject.toml while the npm wrapper lives on
  main). The report carries the detected ecosystem.
- `pyproject-version` (hard): every Python version carrier at the tag must
  agree with the expected version and with each other: pyproject [project] or
  [tool.poetry], setup.cfg [metadata], setup.py, and dynamic versions resolved
  from the file they point at (hatch version path, setuptools dynamic attr or
  file, setup.cfg attr: or file:, or the package __init__ / _version module).
  A dynamic version that cannot be resolved is a FAIL, not a guess.
- `pypi-version` and `pypi-latest` (hard when the project is on PyPI): the
  PyPI mirror of the npm checks, via `shipcheck pypi <pkg> [version]`, the
  `check_pypi` MCP tool, and `--pypi` / the `pypiPackage` option. A project
  absent from PyPI reports SKIP, the same rule the MCP Registry already used,
  because many Python projects ship only via GitHub, GHCR or an npm wrapper.
- `server-version` (hard when server.json is at the tag): the manifest
  version, every package version and every OCI tag inside server.json must
  agree with the release version.
- npm applicability fixed: npm is only checked when a package.json exists at
  the tag or on the default branch (or a package is named explicitly). A pure
  Python release now reports npm as SKIP instead of the old false FAIL that
  made every Python repo a NO-GO. Node and unknown repos keep the old
  behaviour exactly.
- Soft Python structure evidence from the tag tree (reported, never decisive
  alone): `python-tests` (test files plus pytest config when present, else
  the unittest shape), `dockerfile`, `readme`, and `mcp-entry` (a *-mcp or
  server console script from pyproject or setup.cfg, or a server.json).
- Version resolution without an explicit version now reads the Python
  carriers when no package.json version exists.

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
