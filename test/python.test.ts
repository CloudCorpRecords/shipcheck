import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkPypi,
  checkRelease,
  parseInitVersion,
  parsePyproject,
  parseSetupCfg,
  parseSetupPy,
  resolveVersionFromRepo,
} from "../src/check.js";
import type { FetchFn, FetchResponse } from "../src/types.js";

function jsonRes(status: number, body: unknown): FetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

type Route = [string | RegExp, FetchResponse | ((url: string) => FetchResponse)];

function makeFetch(routes: Route[]): FetchFn {
  return async (url: string) => {
    for (const [match, res] of routes) {
      const hit = typeof match === "string" ? url.includes(match) : match.test(url);
      if (hit) return typeof res === "function" ? res(url) : res;
    }
    return jsonRes(404, { message: `no route for ${url}` });
  };
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const fileRes = (s: string): FetchResponse => jsonRes(200, { content: b64(s), encoding: "base64" });

const SHA = "def456def456def456def456def456def456def4";

const PYPROJECT = `[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "pytool"
version = "1.4.0"
description = "A Python tool"
readme = "README.md"
requires-python = ">=3.11"

[project.scripts]
pytool = "pytool.cli:main"
pytool-mcp = "pytool.server:main"

[tool.pytest.ini_options]
testpaths = ["tests"]
`;

function pythonRoutes(overrides: Route[] = []): Route[] {
  const base: Route[] = [
    [/\/repos\/Acme\/pytool$/, jsonRes(200, { default_branch: "main" })],
    [
      "/git/ref/tags/v1.4.0",
      jsonRes(200, { object: { sha: SHA, type: "commit" } }),
    ],
    [`/git/commits/${SHA.slice(0, 12)}`, jsonRes(200, { sha: SHA })],
    [
      `/git/trees/${SHA}`,
      jsonRes(200, {
        truncated: false,
        tree: [
          { path: "pyproject.toml", type: "blob" },
          { path: "README.md", type: "blob" },
          { path: "Dockerfile", type: "blob" },
          { path: "src/pytool/__init__.py", type: "blob" },
          { path: "src/pytool/server.py", type: "blob" },
          { path: "tests/test_core.py", type: "blob" },
          { path: "tests/conftest.py", type: "blob" },
        ],
      }),
    ],
    ["/contents/pyproject.toml", fileRes(PYPROJECT)],
    [
      "/contents/server.json",
      fileRes(
        JSON.stringify({
          name: "io.github.Acme/pytool",
          version: "1.4.0",
          packages: [{ identifier: "pytool", registryType: "pypi", version: "1.4.0" }],
        }),
      ),
    ],
    [
      "/releases/tags/v1.4.0",
      jsonRes(200, {
        tag_name: "v1.4.0",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/Acme/pytool/releases/tag/v1.4.0",
      }),
    ],
    ["registry.npmjs.org", jsonRes(404, {})],
    [
      "pypi.org",
      jsonRes(200, {
        info: { version: "1.4.0" },
        releases: { "1.4.0": [{ filename: "pytool-1.4.0.tar.gz" }], "1.3.0": [{ filename: "x" }] },
      }),
    ],
    ["registry.modelcontextprotocol.io", jsonRes(404, {})],
    ["ghcr.io/token", jsonRes(403, {})],
  ];
  return [...overrides, ...base];
}

describe("Python metadata parsers", () => {
  it("parsePyproject reads PEP 621 name, version, scripts and pytest config", () => {
    const info = parsePyproject(PYPROJECT);
    assert.equal(info.name, "pytool");
    assert.equal(info.version, "1.4.0");
    assert.equal(info.dynamicVersion, false);
    assert.equal(info.scripts["pytool-mcp"], "pytool.server:main");
    assert.equal(info.hasPytestConfig, true);
  });

  it("parsePyproject reads Poetry metadata and multiline dynamic", () => {
    const poetry = parsePyproject(`[tool.poetry]
name = "oldtool"
version = "0.9.1"
`);
    assert.equal(poetry.name, "oldtool");
    assert.equal(poetry.version, "0.9.1");
    const dyn = parsePyproject(`[project]
name = "dyntool"
dynamic = [
  "version",
]
`);
    assert.equal(dyn.dynamicVersion, true);
    assert.equal(dyn.version, undefined);
  });

  it("parsePyproject reads hatch and setuptools dynamic version pointers", () => {
    const hatch = parsePyproject(`[project]
name = "squidlike"
dynamic = ["version"]

[tool.hatch.version]
path = "squidlike/__init__.py"
`);
    assert.equal(hatch.dynamicVersion, true);
    assert.equal(hatch.hatchVersionPath, "squidlike/__init__.py");
    const st = parsePyproject(`[project]
name = "sttool"
dynamic = ["version"]

[tool.setuptools.dynamic]
version = {attr = "sttool.__version__"}
`);
    assert.equal(st.dynamicVersionAttr, "sttool.__version__");
  });

  it("parseSetupCfg reads static version, attr version and entry points", () => {
    const cfg = parseSetupCfg(`[metadata]
name = cfgtool
version = 2.0.0

[options.entry_points]
console_scripts =
    cfgtool-mcp = cfgtool.server:main
`);
    assert.equal(cfg.name, "cfgtool");
    assert.equal(cfg.version, "2.0.0");
    assert.equal(cfg.entryPoints["cfgtool-mcp"], "cfgtool.server:main");
    const attr = parseSetupCfg(`[metadata]
name = atool
version = attr: atool.__version__
`);
    assert.equal(attr.version, undefined);
    assert.equal(attr.dynamicVersionAttr, "atool.__version__");
  });

  it("parseSetupPy and parseInitVersion read static versions", () => {
    const py = parseSetupPy(`from setuptools import setup
setup(name="legacytool", version="3.1.4")
`);
    assert.deepEqual(py, { name: "legacytool", version: "3.1.4" });
    assert.equal(parseInitVersion(`__version__ = "0.5.0"\n`), "0.5.0");
    assert.equal(parseInitVersion(`__version__ = (1, 2, 3)\n`), "1.2.3");
    assert.equal(parseInitVersion(`VERSION = "9.9"\n`), "9.9");
  });
});

describe("checkPypi", () => {
  it("passes when the version exists with files and latest matches", async () => {
    const fetchFn = makeFetch([
      [
        "pypi.org",
        jsonRes(200, {
          info: { version: "1.4.0" },
          releases: { "1.4.0": [{ filename: "a" }], "1.3.0": [{ filename: "b" }] },
        }),
      ],
    ]);
    const r = await checkPypi(fetchFn, "pytool", "1.4.0");
    assert.equal(r.exists, true);
    assert.equal(r.checks.find((c) => c.surface === "pypi-version")?.status, "pass");
    assert.equal(r.checks.find((c) => c.surface === "pypi-latest")?.status, "pass");
  });

  it("fails when the version is missing or fileless, and when latest is behind", async () => {
    const fetchFn = makeFetch([
      [
        "pypi.org",
        jsonRes(200, {
          info: { version: "1.3.0" },
          releases: { "1.4.0": [], "1.3.0": [{ filename: "b" }] },
        }),
      ],
    ]);
    const r = await checkPypi(fetchFn, "pytool", "1.4.0");
    assert.equal(r.checks.find((c) => c.surface === "pypi-version")?.status, "fail");
    assert.equal(r.checks.find((c) => c.surface === "pypi-latest")?.status, "fail");
  });

  it("skips (does not fail) when the package is absent from PyPI", async () => {
    const fetchFn = makeFetch([["pypi.org", jsonRes(404, {})]]);
    const r = await checkPypi(fetchFn, "wallcheck", "0.5.0");
    assert.equal(r.exists, false);
    assert.ok(r.checks.every((c) => c.status === "skip"));
  });
});

describe("checkRelease Python mode", () => {
  it("GO for a pure Python repo: pyproject and server.json agree, PyPI live, npm skipped", async () => {
    const report = await checkRelease(makeFetch(pythonRoutes()), "Acme/pytool", "1.4.0");
    assert.equal(report.verdict, "GO");
    assert.equal(report.ecosystem, "python");
    const by = (s: string) => report.checks.find((c) => c.surface === s);
    assert.equal(by("pyproject-version")?.status, "pass");
    assert.equal(by("server-version")?.status, "pass");
    assert.equal(by("tag-version")?.status, "skip");
    assert.equal(by("npm-version")?.status, "skip");
    assert.equal(by("npm-version")?.hard, false);
    assert.equal(by("npm-latest")?.status, "skip");
    assert.equal(by("pypi-version")?.status, "pass");
    assert.equal(by("pypi-latest")?.status, "pass");
    assert.equal(by("python-tests")?.status, "pass");
    assert.equal(by("dockerfile")?.status, "pass");
    assert.equal(by("readme")?.status, "pass");
    assert.equal(by("mcp-entry")?.status, "pass");
  });

  it("resolves the version from pyproject.toml when none is passed", async () => {
    const fetchFn = makeFetch(pythonRoutes());
    assert.equal(await resolveVersionFromRepo(fetchFn, "Acme", "pytool"), "1.4.0");
    const report = await checkRelease(fetchFn, "Acme/pytool", undefined);
    assert.equal(report.version, "1.4.0");
    assert.equal(report.verdict, "GO");
  });

  it("NO-GO when pyproject.toml at the tag carries a different version", async () => {
    const fetchFn = makeFetch(
      pythonRoutes([
        ["/contents/pyproject.toml", fileRes(PYPROJECT.replace('version = "1.4.0"', 'version = "1.3.0"'))],
      ]),
    );
    const report = await checkRelease(fetchFn, "Acme/pytool", "1.4.0");
    assert.equal(report.verdict, "NO-GO");
    assert.equal(report.checks.find((c) => c.surface === "pyproject-version")?.status, "fail");
  });

  it("NO-GO when PyPI latest is behind the release", async () => {
    const fetchFn = makeFetch(
      pythonRoutes([
        [
          "pypi.org",
          jsonRes(200, {
            info: { version: "1.3.0" },
            releases: { "1.4.0": [{ filename: "a" }], "1.3.0": [{ filename: "b" }] },
          }),
        ],
      ]),
    );
    const report = await checkRelease(fetchFn, "Acme/pytool", "1.4.0");
    assert.equal(report.verdict, "NO-GO");
    assert.equal(report.checks.find((c) => c.surface === "pypi-latest")?.status, "fail");
  });

  it("NO-GO when server.json at the tag disagrees", async () => {
    const fetchFn = makeFetch(
      pythonRoutes([
        [
          "/contents/server.json",
          fileRes(
            JSON.stringify({
              name: "io.github.Acme/pytool",
              version: "1.3.0",
              packages: [{ identifier: "pytool", registryType: "pypi", version: "1.3.0" }],
            }),
          ),
        ],
      ]),
    );
    const report = await checkRelease(fetchFn, "Acme/pytool", "1.4.0");
    assert.equal(report.verdict, "NO-GO");
    assert.equal(report.checks.find((c) => c.surface === "server-version")?.status, "fail");
  });

  it("GO when the project is not on PyPI at all (PyPI skips, like the registry)", async () => {
    const fetchFn = makeFetch(pythonRoutes([["pypi.org", jsonRes(404, {})]]));
    const report = await checkRelease(fetchFn, "Acme/pytool", "1.4.0");
    assert.equal(report.verdict, "GO");
    assert.equal(report.checks.find((c) => c.surface === "pypi-version")?.status, "skip");
  });

  it("resolves a hatch-style dynamic version from the version file", async () => {
    const dynPyproject = `[project]
name = "pytool"
dynamic = ["version"]

[project.scripts]
pytool-mcp = "pytool.server:main"

[tool.hatch.version]
path = "src/pytool/__init__.py"
`;
    const fetchFn = makeFetch(
      pythonRoutes([
        ["/contents/pyproject.toml", fileRes(dynPyproject)],
        ["/contents/src/pytool/__init__.py", fileRes(`__version__ = "1.4.0"\n`)],
      ]),
    );
    const report = await checkRelease(fetchFn, "Acme/pytool", "1.4.0");
    assert.equal(report.checks.find((c) => c.surface === "pyproject-version")?.status, "pass");
    assert.equal(report.verdict, "GO");
  });

  it("NO-GO when a dynamic version cannot be resolved from any version file", async () => {
    const dynPyproject = `[project]
name = "pytool"
dynamic = ["version"]
`;
    const fetchFn = makeFetch(
      pythonRoutes([["/contents/pyproject.toml", fileRes(dynPyproject)]]),
    );
    const report = await checkRelease(fetchFn, "Acme/pytool", "1.4.0");
    assert.equal(report.verdict, "NO-GO");
    assert.equal(report.checks.find((c) => c.surface === "pyproject-version")?.status, "fail");
  });

  it("skip python removes every Python surface", async () => {
    const report = await checkRelease(makeFetch(pythonRoutes()), "Acme/pytool", "1.4.0", {
      skip: ["python"],
    });
    assert.ok(!report.checks.some((c) => c.surface === "pyproject-version"));
    assert.ok(!report.checks.some((c) => c.surface === "python-tests"));
    assert.ok(!report.checks.some((c) => c.surface === "mcp-entry"));
  });
});

const SETUP_CFG = `[metadata]
name = cfgtool
version = 2.0.0
description = A setup.cfg tool

[options.entry_points]
console_scripts =
    cfgtool-mcp = cfgtool.server:main
`;

function cfgRoutes(): Route[] {
  return [
    [/\/repos\/Acme\/cfgtool$/, jsonRes(200, { default_branch: "main" })],
    ["/git/ref/tags/v2.0.0", jsonRes(200, { object: { sha: SHA, type: "commit" } })],
    [`/git/commits/${SHA.slice(0, 12)}`, jsonRes(200, { sha: SHA })],
    [
      `/git/trees/${SHA}`,
      jsonRes(200, {
        truncated: false,
        tree: [
          { path: "setup.cfg", type: "blob" },
          { path: "setup.py", type: "blob" },
          { path: "README.md", type: "blob" },
          { path: "cfgtool/__init__.py", type: "blob" },
          { path: "tests/test_cfg.py", type: "blob" },
        ],
      }),
    ],
    ["/contents/setup.cfg", fileRes(SETUP_CFG)],
    ["/contents/setup.py", fileRes(`from setuptools import setup\nsetup()\n`)],
    [
      "/releases/tags/v2.0.0",
      jsonRes(200, { tag_name: "v2.0.0", draft: false, prerelease: false }),
    ],
    ["registry.npmjs.org", jsonRes(404, {})],
    [
      "pypi.org",
      jsonRes(200, {
        info: { version: "2.0.0" },
        releases: { "2.0.0": [{ filename: "cfgtool-2.0.0.tar.gz" }] },
      }),
    ],
    ["registry.modelcontextprotocol.io", jsonRes(404, {})],
    ["ghcr.io/token", jsonRes(403, {})],
  ];
}

describe("checkRelease setup.cfg mode", () => {
  it("GO for a setup.cfg-only repo, version carried by setup.cfg", async () => {
    const report = await checkRelease(makeFetch(cfgRoutes()), "Acme/cfgtool", "2.0.0");
    assert.equal(report.verdict, "GO");
    assert.equal(report.ecosystem, "python");
    const pv = report.checks.find((c) => c.surface === "pyproject-version");
    assert.equal(pv?.status, "pass");
    assert.match(pv?.detail ?? "", /setup\.cfg/);
    assert.equal(report.checks.find((c) => c.surface === "pypi-version")?.status, "pass");
    assert.equal(report.checks.find((c) => c.surface === "mcp-entry")?.status, "pass");
    assert.equal(report.checks.find((c) => c.surface === "python-tests")?.status, "pass");
  });
});

function hybridRoutes(pyVersion: string): Route[] {
  const pkgJson = JSON.stringify({ name: "@reneturcios/wallpy", version: "0.5.0" });
  const pyproject = `[project]
name = "wallpy"
version = "${pyVersion}"

[project.scripts]
wallpy = "wallpy.cli:main"
wallpy-mcp = "wallpy.server:main"
`;
  return [
    [/\/repos\/Acme\/wallpy$/, jsonRes(200, { default_branch: "main" })],
    ["/git/ref/tags/v0.5.0", jsonRes(200, { object: { sha: SHA, type: "commit" } })],
    [`/git/commits/${SHA.slice(0, 12)}`, jsonRes(200, { sha: SHA })],
    [
      `/git/trees/${SHA}`,
      jsonRes(200, {
        truncated: false,
        tree: [
          { path: "pyproject.toml", type: "blob" },
          { path: "README.md", type: "blob" },
          { path: "Dockerfile", type: "blob" },
          { path: "src/wallpy/__init__.py", type: "blob" },
          { path: "tests/test_wall.py", type: "blob" },
        ],
      }),
    ],
    // The wallcheck shape: no package.json at the tag, one on main.
    [
      "/contents/package.json",
      (url: string) =>
        url.includes("ref=v0.5.0") ? jsonRes(404, {}) : fileRes(pkgJson),
    ],
    ["/contents/pyproject.toml", fileRes(pyproject)],
    [
      "/contents/server.json",
      fileRes(
        JSON.stringify({
          name: "io.github.Acme/wallpy",
          version: "0.5.0",
          packages: [
            { identifier: "@reneturcios/wallpy", registryType: "npm", version: "0.5.0" },
            { identifier: "ghcr.io/acme/wallpy:0.5.0", registryType: "oci" },
          ],
        }),
      ),
    ],
    [
      "/releases/tags/v0.5.0",
      jsonRes(200, { tag_name: "v0.5.0", draft: false, prerelease: false }),
    ],
    [
      "registry.npmjs.org",
      jsonRes(200, { "dist-tags": { latest: "0.5.0" }, versions: { "0.5.0": {} } }),
    ],
    ["pypi.org", jsonRes(404, {})],
    ["registry.modelcontextprotocol.io", jsonRes(404, {})],
    ["ghcr.io/token", jsonRes(403, {})],
  ];
}

describe("checkRelease hybrid mode (the wallcheck shape)", () => {
  it("GO when pyproject at the tag and the npm wrapper on main agree", async () => {
    const report = await checkRelease(makeFetch(hybridRoutes("0.5.0")), "Acme/wallpy", "0.5.0");
    assert.equal(report.verdict, "GO");
    assert.equal(report.ecosystem, "hybrid");
    const by = (s: string) => report.checks.find((c) => c.surface === s);
    assert.equal(by("tag-version")?.status, "skip");
    assert.equal(by("pyproject-version")?.status, "pass");
    assert.equal(by("server-version")?.status, "pass");
    assert.equal(by("npm-version")?.status, "pass");
    assert.equal(by("pypi-version")?.status, "skip");
  });

  it("NO-GO when pyproject disagrees even though package.json and npm agree", async () => {
    const report = await checkRelease(makeFetch(hybridRoutes("0.4.0")), "Acme/wallpy", "0.5.0");
    assert.equal(report.verdict, "NO-GO");
    assert.equal(report.checks.find((c) => c.surface === "pyproject-version")?.status, "fail");
    assert.equal(report.checks.find((c) => c.surface === "npm-version")?.status, "pass");
  });
});

function appRoutes(withTests: boolean): Route[] {
  const tree = [
    { path: "app.py", type: "blob" },
    { path: "data_quality.py", type: "blob" },
    { path: "requirements.txt", type: "blob" },
    { path: "README.md", type: "blob" },
    ...(withTests ? [{ path: "tests/test_data_quality.py", type: "blob" }] : []),
  ];
  return [
    [/\/repos\/Acme\/appboi$/, jsonRes(200, { default_branch: "main" })],
    ["/git/ref/tags/v1.2.0", jsonRes(200, { object: { sha: SHA, type: "commit" } })],
    [`/git/commits/${SHA.slice(0, 12)}`, jsonRes(200, { sha: SHA })],
    [`/git/trees/${SHA}`, jsonRes(200, { truncated: false, tree })],
    [
      "/releases/tags/v1.2.0",
      jsonRes(200, { tag_name: "v1.2.0", draft: false, prerelease: false }),
    ],
    ["registry.npmjs.org", jsonRes(404, {})],
    ["pypi.org", jsonRes(404, {})],
    ["registry.modelcontextprotocol.io", jsonRes(404, {})],
    ["ghcr.io/token", jsonRes(403, {})],
  ];
}

describe("checkRelease incomplete Python app (the trainerboi shape)", () => {
  it("GO with honest skips: no metadata carriers, npm and PyPI do not apply", async () => {
    const report = await checkRelease(makeFetch(appRoutes(true)), "Acme/appboi", "1.2.0");
    assert.equal(report.verdict, "GO");
    assert.equal(report.ecosystem, "python");
    const by = (s: string) => report.checks.find((c) => c.surface === s);
    assert.equal(by("pyproject-version")?.status, "skip");
    assert.equal(by("pyproject-version")?.hard, false);
    assert.equal(by("npm-version")?.status, "skip");
    assert.equal(by("pypi-version")?.status, "skip");
    assert.equal(by("python-tests")?.status, "pass");
    assert.equal(by("dockerfile")?.status, "skip");
    assert.equal(by("readme")?.status, "pass");
    assert.equal(by("mcp-entry")?.status, "skip");
  });

  it("reports missing tests as a soft fail that does not change the verdict", async () => {
    const report = await checkRelease(makeFetch(appRoutes(false)), "Acme/appboi", "1.2.0");
    const t = report.checks.find((c) => c.surface === "python-tests");
    assert.equal(t?.status, "fail");
    assert.equal(t?.hard, false);
    assert.equal(report.verdict, "GO");
  });
});
