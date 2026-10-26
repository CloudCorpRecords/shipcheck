/**
 * shipcheck core: verify every public surface of a release agrees on one version.
 *
 * All network access goes through an injectable FetchFn so the whole logic is
 * testable with fixtures. Every check reports expected vs actual plus the
 * source URL. A failed fetch is an "error" check with the HTTP status, never
 * a guessed pass or fail.
 *
 * Python mode: a repo is a Python project when pyproject.toml, setup.py or
 * setup.cfg is present at the tag or on the default branch, or when the tag
 * tree is a Python tree (.py files, requirements files) with no other
 * metadata carrier. Python projects get their version read from the Python
 * carriers (pyproject [project] or [tool.poetry], setup.cfg [metadata],
 * setup.py, plus dynamic versions resolved from the version file they point
 * at), get PyPI checked the way npm is checked for Node projects, and get
 * soft structure evidence (test runner, Dockerfile, README, MCP entry point)
 * read from the tag tree. npm only applies when a package.json exists at the
 * tag or on the default branch, so a pure Python release is no longer failed
 * for not being on npm, and a hybrid repo (wallcheck: pyproject at the tag,
 * npm wrapper on main) is checked on every carrier it actually has.
 */
import type { CheckOptions, FetchFn, ShipReport, SurfaceCheck } from "./types.js";

export const VERSION = "0.2.0";

const GH_API = "https://api.github.com";
const NPM_API = "https://registry.npmjs.org";
const PYPI_API = "https://pypi.org";
const REGISTRY_API = "https://registry.modelcontextprotocol.io";

export const SURFACE_GROUPS: Record<string, string[]> = {
  github: ["git-tag", "tag-commit", "tag-version", "github-release"],
  release: ["github-release"],
  npm: ["npm-version", "npm-latest"],
  pypi: ["pypi-version", "pypi-latest"],
  python: ["pyproject-version", "python-tests", "dockerfile", "readme", "mcp-entry"],
  server: ["server-version"],
  registry: ["registry-version", "registry-latest"],
  ghcr: ["ghcr-tag", "ghcr-latest"],
};

export function expandSurfaces(names: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const n of names ?? []) {
    const key = n.trim().toLowerCase();
    if (!key) continue;
    if (SURFACE_GROUPS[key]) for (const s of SURFACE_GROUPS[key]) out.add(s);
    else out.add(key);
  }
  return out;
}

export function parseRepoRef(ref: string): { owner: string; repo: string } {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(ref.trim().replace(/\.git$/, ""));
  if (!m) throw new Error(`Expected owner/repo, got: ${ref}`);
  return { owner: m[1], repo: m[2] };
}

export function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/, "");
}

/** PEP 440-ish comparison form: case and separator differences do not count. */
export function normalizePypiVersion(v: string): string {
  return normalizeVersion(v).toLowerCase().replace(/[-_]/g, ".");
}

export function computeVerdict(checks: SurfaceCheck[]): "GO" | "NO-GO" {
  return checks.some((c) => c.hard && (c.status === "fail" || c.status === "error"))
    ? "NO-GO"
    : "GO";
}

function ghHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": `shipcheck/${VERSION}`,
    Accept: "application/vnd.github+json",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

interface GhJson {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

async function ghJson(
  fetchFn: FetchFn,
  path: string,
  token?: string,
): Promise<GhJson> {
  const res = await fetchFn(`${GH_API}${path}`, { headers: ghHeaders(token) });
  if (!res.ok) return { ok: false, status: res.status, data: null };
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: true, status: res.status, data };
}

function decodeContent(data: Record<string, unknown>): string | null {
  const content = data.content;
  if (typeof content !== "string") return null;
  try {
    return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Read one repo file at a ref through the contents API. Null when absent. */
export async function fetchRepoFile(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  token?: string,
): Promise<string | null> {
  const r = await ghJson(
    fetchFn,
    `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    token,
  );
  if (!r.ok || !r.data) return null;
  return decodeContent(r.data);
}

/** Read package.json (name + version) from the repo at a ref. Null when absent. */
export async function fetchPackageJson(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  ref: string,
  token?: string,
): Promise<{ name?: string; version?: string } | null> {
  const raw = await fetchRepoFile(fetchFn, owner, repo, "package.json", ref, token);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { name?: string; version?: string };
    return { name: parsed.name, version: parsed.version };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Python metadata parsing. These are deliberately small, strict parsers for
// the version-bearing subset of each format: they read the sections and keys
// that carry a name, a version, entry points and pytest config, and nothing
// else. A value they cannot read is reported as absent, never guessed.
// ---------------------------------------------------------------------------

export interface PyprojectInfo {
  name?: string;
  version?: string;
  /** True when [project] lists "version" in dynamic = [...]. */
  dynamicVersion: boolean;
  /** attr = "pkg.__version__" from [tool.setuptools.dynamic] version. */
  dynamicVersionAttr?: string;
  /** file = "path" from [tool.setuptools.dynamic] version. */
  dynamicVersionFile?: string;
  /** path = "..." from [tool.hatch.version]. */
  hatchVersionPath?: string;
  /** [project.scripts] entry points. */
  scripts: Record<string, string>;
  hasPytestConfig: boolean;
}

function tomlString(rhs: string): string | undefined {
  const m = /"([^"]*)"|'([^']*)'/.exec(rhs);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

export function parsePyproject(text: string): PyprojectInfo {
  const info: PyprojectInfo = { dynamicVersion: false, scripts: {}, hasPytestConfig: false };
  let section = "";
  let inDynamic = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      inDynamic = false;
      if (section === "tool.pytest" || section.startsWith("tool.pytest.")) {
        info.hasPytestConfig = true;
      }
      continue;
    }
    if (inDynamic) {
      if (/"version"/.test(line)) info.dynamicVersion = true;
      if (line.includes("]")) inDynamic = false;
      continue;
    }
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().replace(/^"|"$/g, "");
    const rhs = kv[2].trim();
    if (section === "project") {
      if (key === "name") info.name = tomlString(rhs);
      else if (key === "version") info.version = tomlString(rhs);
      else if (key === "dynamic") {
        if (/"version"/.test(rhs)) info.dynamicVersion = true;
        if (!rhs.includes("]")) inDynamic = true;
      }
    } else if (section === "tool.poetry") {
      if (key === "name" && !info.name) info.name = tomlString(rhs);
      else if (key === "version" && !info.version) info.version = tomlString(rhs);
    } else if (section === "project.scripts") {
      const v = tomlString(rhs);
      if (v) info.scripts[key] = v;
    } else if (section === "tool.hatch.version") {
      if (key === "path") info.hatchVersionPath = tomlString(rhs);
    } else if (section === "tool.setuptools.dynamic") {
      if (key === "version") {
        const attr = /attr\s*=\s*"([^"]+)"/.exec(rhs) ?? /attr\s*=\s*'([^']+)'/.exec(rhs);
        const file = /file\s*=\s*"([^"]+)"/.exec(rhs) ?? /file\s*=\s*'([^']+)'/.exec(rhs);
        if (attr) info.dynamicVersionAttr = attr[1];
        if (file) info.dynamicVersionFile = file[1];
      }
    }
  }
  return info;
}

export interface SetupCfgInfo {
  name?: string;
  version?: string;
  /** version = attr: pkg.__version__ */
  dynamicVersionAttr?: string;
  /** version = file: path */
  dynamicVersionFile?: string;
  /** console_scripts entry points from [options.entry_points]. */
  entryPoints: Record<string, string>;
  hasPytestConfig: boolean;
}

export function parseSetupCfg(text: string): SetupCfgInfo {
  const info: SetupCfgInfo = { entryPoints: {}, hasPytestConfig: false };
  let section = "";
  let inEntryPoints = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      inEntryPoints = false;
      if (section === "tool:pytest") info.hasPytestConfig = true;
      continue;
    }
    if (section === "options.entry_points" && line === "console_scripts =") {
      inEntryPoints = true;
      continue;
    }
    if (inEntryPoints) {
      const ep = /^([^=]+?)\s*=\s*(\S+)\s*$/.exec(line);
      if (ep) {
        info.entryPoints[ep[1].trim()] = ep[2].trim();
        continue;
      }
      inEntryPoints = false;
    }
    if (section !== "metadata") continue;
    const kv = /^([^=]+?)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const rhs = kv[2].trim();
    if (key === "name") info.name = rhs;
    else if (key === "version") {
      if (rhs.startsWith("attr:")) info.dynamicVersionAttr = rhs.slice(5).trim();
      else if (rhs.startsWith("file:")) info.dynamicVersionFile = rhs.slice(5).trim();
      else info.version = rhs;
    }
  }
  return info;
}

/** Best-effort static name/version from a setup.py setup(...) call. */
export function parseSetupPy(text: string): { name?: string; version?: string } {
  const out: { name?: string; version?: string } = {};
  const ver = /\bversion\s*=\s*"([^"]+)"/.exec(text) ?? /\bversion\s*=\s*'([^']+)'/.exec(text);
  if (ver && /^\d/.test(ver[1])) out.version = ver[1];
  const name = /\bname\s*=\s*"([^"]+)"/.exec(text) ?? /\bname\s*=\s*'([^']+)'/.exec(text);
  if (name) out.name = name[1];
  return out;
}

/** Read __version__ (string or tuple) or a bare version assignment. */
export function parseInitVersion(text: string): string | undefined {
  const str =
    /__version__\s*=\s*"([^"]+)"/.exec(text) ?? /__version__\s*=\s*'([^']+)'/.exec(text);
  if (str) return str[1];
  const tuple = /__version__\s*=\s*\(([\d\s,]+)\)/.exec(text);
  if (tuple) {
    const parts = tuple[1].split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts.join(".");
  }
  const bare =
    /^version\s*=\s*"([^"]+)"/m.exec(text) ?? /^VERSION\s*=\s*"([^"]+)"/m.exec(text);
  if (bare) return bare[1];
  return undefined;
}

interface ServerJsonInfo {
  name?: string;
  version?: string;
  packages: { identifier?: string; version?: string }[];
}

function parseServerJson(raw: string): ServerJsonInfo | null {
  try {
    const parsed = JSON.parse(raw) as {
      name?: string;
      version?: string;
      packages?: { identifier?: string; version?: string }[];
    };
    return {
      name: parsed.name,
      version: parsed.version,
      packages: Array.isArray(parsed.packages) ? parsed.packages : [],
    };
  } catch {
    return null;
  }
}

/** Every metadata carrier shipcheck knows how to read, fetched at one ref. */
interface RefMetadata {
  pkg: { name?: string; version?: string } | null;
  pyproject: PyprojectInfo | null;
  setupCfg: SetupCfgInfo | null;
  setupPy: { name?: string; version?: string } | null;
  server: ServerJsonInfo | null;
}

async function fetchRefMetadata(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  ref: string,
  token?: string,
): Promise<RefMetadata> {
  const [pkgRaw, pyRaw, cfgRaw, pySetupRaw, serverRaw] = await Promise.all([
    fetchRepoFile(fetchFn, owner, repo, "package.json", ref, token),
    fetchRepoFile(fetchFn, owner, repo, "pyproject.toml", ref, token),
    fetchRepoFile(fetchFn, owner, repo, "setup.cfg", ref, token),
    fetchRepoFile(fetchFn, owner, repo, "setup.py", ref, token),
    fetchRepoFile(fetchFn, owner, repo, "server.json", ref, token),
  ]);
  let pkg: RefMetadata["pkg"] = null;
  if (pkgRaw) {
    try {
      const parsed = JSON.parse(pkgRaw) as { name?: string; version?: string };
      pkg = { name: parsed.name, version: parsed.version };
    } catch {
      pkg = null;
    }
  }
  return {
    pkg,
    pyproject: pyRaw ? parsePyproject(pyRaw) : null,
    setupCfg: cfgRaw ? parseSetupCfg(cfgRaw) : null,
    setupPy: pySetupRaw ? parseSetupPy(pySetupRaw) : null,
    server: serverRaw ? parseServerJson(serverRaw) : null,
  };
}

function hasPythonMeta(meta: RefMetadata): boolean {
  return Boolean(meta.pyproject || meta.setupCfg || meta.setupPy);
}

function pythonName(meta: RefMetadata): string | undefined {
  return meta.pyproject?.name ?? meta.setupCfg?.name ?? meta.setupPy?.name;
}

/** Candidate files a dynamic Python version can be read from, in order. */
function dynamicVersionCandidates(meta: RefMetadata): string[] {
  const out: string[] = [];
  const push = (p?: string): void => {
    if (p && !out.includes(p)) out.push(p);
  };
  push(meta.pyproject?.hatchVersionPath);
  push(meta.pyproject?.dynamicVersionFile);
  push(meta.setupCfg?.dynamicVersionFile);
  const attrs = [meta.pyproject?.dynamicVersionAttr, meta.setupCfg?.dynamicVersionAttr];
  for (const attr of attrs) {
    if (!attr) continue;
    const parts = attr.split(".");
    if (parts[parts.length - 1] === "__version__") parts.pop();
    if (parts.length === 0) continue;
    const base = parts.join("/");
    push(`${base}.py`);
    push(`${base}/__init__.py`);
    push(`src/${base}.py`);
    push(`src/${base}/__init__.py`);
  }
  const name = pythonName(meta);
  if (name) {
    const mod = name.replace(/-/g, "_");
    push(`${mod}/__init__.py`);
    push(`src/${mod}/__init__.py`);
    push(`${mod}/_version.py`);
    push(`src/${mod}/_version.py`);
    push(`${mod}/version.py`);
    push(`src/${mod}/version.py`);
  }
  return out;
}

interface PythonVersionEvidence {
  /** One entry per carrier file that carries a readable version at the ref. */
  found: { carrier: string; version: string }[];
  /** A carrier declares a dynamic version but no version file could be read. */
  dynamicUnresolved: boolean;
  name?: string;
}

/** Collect every Python version carrier at a ref, resolving dynamic ones. */
async function collectPythonVersions(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  ref: string,
  meta: RefMetadata,
  token?: string,
): Promise<PythonVersionEvidence> {
  const found: { carrier: string; version: string }[] = [];
  let dynamicDeclared = false;
  if (meta.pyproject?.version) {
    found.push({ carrier: "pyproject.toml", version: meta.pyproject.version });
  } else if (
    meta.pyproject &&
    (meta.pyproject.dynamicVersion ||
      meta.pyproject.hatchVersionPath ||
      meta.pyproject.dynamicVersionAttr ||
      meta.pyproject.dynamicVersionFile)
  ) {
    dynamicDeclared = true;
  }
  if (meta.setupCfg?.version) {
    found.push({ carrier: "setup.cfg", version: meta.setupCfg.version });
  } else if (meta.setupCfg?.dynamicVersionAttr || meta.setupCfg?.dynamicVersionFile) {
    dynamicDeclared = true;
  }
  if (meta.setupPy?.version) {
    found.push({ carrier: "setup.py", version: meta.setupPy.version });
  }
  if (dynamicDeclared) {
    for (const candidate of dynamicVersionCandidates(meta)) {
      const raw = await fetchRepoFile(fetchFn, owner, repo, candidate, ref, token);
      if (!raw) continue;
      const v = parseInitVersion(raw);
      if (v) {
        found.push({ carrier: `dynamic version file ${candidate}`, version: v });
        dynamicDeclared = false;
        break;
      }
    }
  }
  return { found, dynamicUnresolved: dynamicDeclared, name: pythonName(meta) };
}

async function getDefaultBranch(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  token?: string,
): Promise<string> {
  const repoInfo = await ghJson(fetchFn, `/repos/${owner}/${repo}`, token);
  return (repoInfo.data?.default_branch as string | undefined) ?? "main";
}

/** Resolve the expected version from the repo metadata on the default branch. */
export async function resolveVersionFromRepo(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  token?: string,
): Promise<string> {
  const branch = await getDefaultBranch(fetchFn, owner, repo, token);
  const meta = await fetchRefMetadata(fetchFn, owner, repo, branch, token);
  if (meta.pkg?.version) return normalizeVersion(meta.pkg.version);
  const py = await collectPythonVersions(fetchFn, owner, repo, branch, meta, token);
  if (py.found.length > 0) return normalizeVersion(py.found[0].version);
  throw new Error(
    `Could not read a version from package.json, pyproject.toml, setup.cfg or setup.py on ${owner}/${repo}@${branch}. Pass a version explicitly.`,
  );
}

interface GitHubOutcome {
  checks: SurfaceCheck[];
  npmName?: string;
  pypiName?: string;
  serverName?: string;
  hasNode: boolean;
  hasPython: boolean;
  ecosystem: "node" | "python" | "hybrid" | "unknown";
}

async function fetchTagTree(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  commitSha: string,
  token?: string,
): Promise<{ paths: string[]; truncated: boolean } | null> {
  const r = await ghJson(
    fetchFn,
    `/repos/${owner}/${repo}/git/trees/${commitSha}?recursive=1`,
    token,
  );
  if (!r.ok || !r.data || !Array.isArray(r.data.tree)) return null;
  const paths: string[] = [];
  for (const entry of r.data.tree as { path?: string; type?: string }[]) {
    if (entry.type === "blob" && typeof entry.path === "string") paths.push(entry.path);
  }
  return { paths, truncated: r.data.truncated === true };
}

async function checkGitHub(
  fetchFn: FetchFn,
  owner: string,
  repo: string,
  version: string,
  skip: Set<string>,
  mainMeta: RefMetadata,
  token?: string,
): Promise<GitHubOutcome> {
  const checks: SurfaceCheck[] = [];
  const tag = `v${version}`;
  const repoPath = `/repos/${owner}/${repo}`;

  const tagMeta = await fetchRefMetadata(fetchFn, owner, repo, tag, token);

  // git-tag + tag-commit: the tag must exist and resolve to a real commit.
  // This is the check that would have caught a tag pointing at a
  // nonexistent object: the ref can exist while its target does not.
  let commitSha: string | undefined;
  if (!skip.has("git-tag")) {
    const refRes = await ghJson(fetchFn, `${repoPath}/git/ref/tags/${tag}`, token);
    if (!refRes.ok || !refRes.data) {
      checks.push({
        surface: "git-tag",
        status: refRes.status === 404 ? "fail" : "error",
        hard: true,
        expected: tag,
        detail:
          refRes.status === 404
            ? `No git tag ${tag} on ${owner}/${repo}`
            : `GitHub API returned ${refRes.status} for the tag ref`,
        source: `https://github.com/${owner}/${repo}/tags`,
      });
    } else {
      const obj = refRes.data.object as { sha?: string; type?: string } | undefined;
      checks.push({
        surface: "git-tag",
        status: "pass",
        hard: true,
        expected: tag,
        actual: obj?.sha,
        detail: `Tag ${tag} exists (object type ${obj?.type ?? "unknown"})`,
        source: `https://github.com/${owner}/${repo}/releases/tag/${tag}`,
      });
      if (obj?.sha && obj.type === "commit") {
        commitSha = obj.sha;
      } else if (obj?.sha && obj.type === "tag") {
        const tagObj = await ghJson(fetchFn, `${repoPath}/git/tags/${obj.sha}`, token);
        const inner = tagObj.data?.object as { sha?: string } | undefined;
        if (tagObj.ok && inner?.sha) commitSha = inner.sha;
      }
      if (!skip.has("tag-commit")) {
        if (!commitSha) {
          checks.push({
            surface: "tag-commit",
            status: "fail",
            hard: true,
            expected: "a commit object",
            detail: `Tag ${tag} does not resolve to a commit object`,
          });
        } else {
          const commit = await ghJson(fetchFn, `${repoPath}/git/commits/${commitSha}`, token);
          checks.push({
            surface: "tag-commit",
            status: commit.ok ? "pass" : "fail",
            hard: true,
            expected: "a real commit",
            actual: commitSha,
            detail: commit.ok
              ? `Tag resolves to real commit ${commitSha.slice(0, 12)}`
              : `Tag target ${commitSha.slice(0, 12)} is not a real commit (GitHub API ${commit.status})`,
            source: `https://github.com/${owner}/${repo}/commit/${commitSha}`,
          });
        }
      }
    }
  }

  // tag-version: package.json at the tag must carry the expected version.
  let npmName: string | undefined = tagMeta.pkg?.name ?? mainMeta.pkg?.name;
  const pkgAtTag = tagMeta.pkg;
  if (!skip.has("tag-version")) {
    if (!pkgAtTag) {
      checks.push({
        surface: "tag-version",
        status: "skip",
        hard: true,
        detail: hasPythonMeta(tagMeta)
          ? `No package.json at ${tag} (Python project), the version is carried by pyproject-version instead`
          : `No readable package.json at ${tag}, nothing to compare`,
      });
    } else {
      const actual = pkgAtTag.version ? normalizeVersion(pkgAtTag.version) : undefined;
      checks.push({
        surface: "tag-version",
        status: actual === version ? "pass" : "fail",
        hard: true,
        expected: version,
        actual,
        detail:
          actual === version
            ? `package.json at ${tag} is version ${version}`
            : `package.json at ${tag} is version ${actual ?? "unknown"}, expected ${version}`,
        source: `https://github.com/${owner}/${repo}/blob/${tag}/package.json`,
      });
    }
  }

  // pyproject-version: every Python version carrier at the tag (pyproject.toml,
  // setup.cfg, setup.py, and any dynamic version file they point at) must
  // agree with the expected version and with each other.
  const pyAtTag = await collectPythonVersions(fetchFn, owner, repo, tag, tagMeta, token);
  const pypiName = pyAtTag.name ?? pythonName(mainMeta);
  let pythonByMeta = hasPythonMeta(tagMeta) || hasPythonMeta(mainMeta);
  if (!skip.has("pyproject-version") && pythonByMeta) {
    if (pyAtTag.found.length > 0) {
      const bad = pyAtTag.found.filter((f) => normalizeVersion(f.version) !== version);
      const listing = pyAtTag.found.map((f) => `${f.carrier} ${f.version}`).join(", ");
      checks.push({
        surface: "pyproject-version",
        status: bad.length === 0 ? "pass" : "fail",
        hard: true,
        expected: version,
        actual: pyAtTag.found.map((f) => f.version).join(", "),
        detail:
          bad.length === 0
            ? `Python version carriers at ${tag} agree on ${version} (${listing})`
            : `Python version carriers at ${tag} disagree: ${listing}, expected ${version}`,
        source: `https://github.com/${owner}/${repo}/blob/${tag}/pyproject.toml`,
      });
    } else if (pyAtTag.dynamicUnresolved) {
      checks.push({
        surface: "pyproject-version",
        status: "fail",
        hard: true,
        expected: version,
        detail: `Python metadata at ${tag} declares a dynamic version but no version file it points at could be read at ${tag}`,
        source: `https://github.com/${owner}/${repo}/blob/${tag}/pyproject.toml`,
      });
    } else {
      checks.push({
        surface: "pyproject-version",
        status: "skip",
        hard: false,
        detail: `Python metadata exists but no pyproject.toml, setup.cfg or setup.py at ${tag} carries a readable version`,
        source: `https://github.com/${owner}/${repo}/blob/${tag}/pyproject.toml`,
      });
    }
  }

  // server-version: server.json at the tag is the MCP manifest surface. Its
  // own version, and every package version or OCI tag inside it, must agree.
  const serverAtTag = tagMeta.server;
  if (serverAtTag && !skip.has("server-version")) {
    const mismatches: string[] = [];
    if (serverAtTag.version && normalizeVersion(serverAtTag.version) !== version) {
      mismatches.push(`server.json version is ${serverAtTag.version}`);
    }
    for (const p of serverAtTag.packages) {
      if (p.version && normalizeVersion(p.version) !== version) {
        mismatches.push(`package ${p.identifier ?? "?"} has version ${p.version}`);
      }
      if (p.identifier) {
        const lastSlash = p.identifier.lastIndexOf("/");
        const colon = p.identifier.indexOf(":", lastSlash);
        if (colon > lastSlash) {
          const ociTag = p.identifier.slice(colon + 1);
          if (ociTag !== "latest" && normalizeVersion(ociTag) !== version) {
            mismatches.push(`package ${p.identifier} is tagged ${ociTag}`);
          }
        }
      }
    }
    checks.push({
      surface: "server-version",
      status: mismatches.length === 0 ? "pass" : "fail",
      hard: true,
      expected: version,
      actual: serverAtTag.version,
      detail:
        mismatches.length === 0
          ? `server.json at ${tag} agrees on version ${version} across the manifest and its packages`
          : `server.json at ${tag} disagrees: ${mismatches.join("; ")}, expected ${version}`,
      source: `https://github.com/${owner}/${repo}/blob/${tag}/server.json`,
    });
  }

  // github-release
  if (!skip.has("github-release")) {
    const rel = await ghJson(fetchFn, `${repoPath}/releases/tags/${tag}`, token);
    if (!rel.ok || !rel.data) {
      checks.push({
        surface: "github-release",
        status: rel.status === 404 ? "fail" : "error",
        hard: true,
        expected: `release ${tag}`,
        detail:
          rel.status === 404
            ? `No GitHub release for ${tag}`
            : `GitHub API returned ${rel.status} for the release lookup`,
        source: `https://github.com/${owner}/${repo}/releases`,
      });
    } else if (rel.data.draft === true) {
      checks.push({
        surface: "github-release",
        status: "fail",
        hard: true,
        expected: `published release ${tag}`,
        actual: "draft",
        detail: `Release ${tag} exists but is still a draft`,
        source: (rel.data.html_url as string) ?? undefined,
      });
    } else {
      checks.push({
        surface: "github-release",
        status: "pass",
        hard: true,
        expected: `release ${tag}`,
        actual: rel.data.prerelease === true ? `${tag} (prerelease)` : tag,
        detail: `GitHub release ${tag} is published`,
        source: (rel.data.html_url as string) ?? undefined,
      });
    }
  }

  // Python structure evidence from the tag tree (soft checks: reported, they
  // never decide the verdict on their own). This is also how a Python app
  // with no metadata carriers at all (requirements files and .py sources
  // only) is recognised as a Python project.
  let pythonByTree = false;
  const tree = commitSha
    ? await fetchTagTree(fetchFn, owner, repo, commitSha, token)
    : null;
  if (tree) {
    const paths = tree.paths;
    const pyFiles = paths.filter((p) => p.endsWith(".py"));
    const hasRequirements = paths.some((p) => /(^|\/)requirements[^/]*\.txt$/.test(p) || p === "Pipfile");
    pythonByTree = pyFiles.length > 0 || hasRequirements;
    const isPython = pythonByMeta || pythonByTree;
    if (isPython) {
      if (!skip.has("pyproject-version") && !pythonByMeta) {
        checks.push({
          surface: "pyproject-version",
          status: "skip",
          hard: false,
          detail: `Python project detected from the tag tree (${pyFiles.length} .py files) but no pyproject.toml, setup.py or setup.cfg at ${tag} carries a version`,
        });
      }
      if (!skip.has("python-tests")) {
        const testFiles = paths.filter(
          (p) =>
            (/(^|\/)tests?\//.test(p) && p.endsWith(".py")) ||
            /(^|\/)test_[^/]*\.py$/.test(p) ||
            /(^|\/)[^/]*_test\.py$/.test(p),
        );
        const pytestConfigured =
          tagMeta.pyproject?.hasPytestConfig === true ||
          tagMeta.setupCfg?.hasPytestConfig === true ||
          paths.some((p) => /(^|\/)pytest\.ini$/.test(p) || /(^|\/)conftest\.py$/.test(p));
        if (tree.truncated && testFiles.length === 0) {
          checks.push({
            surface: "python-tests",
            status: "skip",
            hard: false,
            detail: `Tag tree was truncated by the GitHub API, test detection is incomplete`,
          });
        } else if (testFiles.length > 0) {
          checks.push({
            surface: "python-tests",
            status: "pass",
            hard: false,
            actual: `${testFiles.length} test files`,
            detail: pytestConfigured
              ? `${testFiles.length} Python test file(s) at ${tag} with pytest configuration detected`
              : `${testFiles.length} Python test file(s) at ${tag}, runner reads as unittest or pytest with no pytest config file found`,
          });
        } else {
          checks.push({
            surface: "python-tests",
            status: "fail",
            hard: false,
            detail: `No Python test files detected in the tag tree at ${tag}`,
          });
        }
      }
      if (!skip.has("dockerfile")) {
        const dockerfile = paths.find((p) => /(^|\/)Dockerfile[^/]*$/.test(p));
        checks.push(
          dockerfile
            ? {
                surface: "dockerfile",
                status: "pass",
                hard: false,
                actual: dockerfile,
                detail: `Dockerfile present at ${tag}: ${dockerfile}`,
              }
            : {
                surface: "dockerfile",
                status: "skip",
                hard: false,
                detail: `No Dockerfile in the tag tree at ${tag}, container checks rest on GHCR alone`,
              },
        );
      }
      if (!skip.has("readme")) {
        const readme = paths.find((p) => /^README[^/]*$/i.test(p));
        checks.push(
          readme
            ? {
                surface: "readme",
                status: "pass",
                hard: false,
                actual: readme,
                detail: `README present at ${tag}: ${readme}`,
              }
            : {
                surface: "readme",
                status: "skip",
                hard: false,
                detail: `No README at the repo root at ${tag}`,
              },
        );
      }
      if (!skip.has("mcp-entry")) {
        const scriptEntries = {
          ...(tagMeta.pyproject?.scripts ?? {}),
          ...(tagMeta.setupCfg?.entryPoints ?? {}),
        };
        const mcpScripts = Object.entries(scriptEntries).filter(
          ([name, target]) =>
            name.endsWith("-mcp") || target.includes(".server:") || target.includes("server:"),
        );
        if (mcpScripts.length > 0) {
          const [name, target] = mcpScripts[0];
          checks.push({
            surface: "mcp-entry",
            status: "pass",
            hard: false,
            actual: `${name} = ${target}`,
            detail: `MCP server entry point at ${tag}: ${name} = ${target}${tagMeta.server ? ", with server.json present" : ""}`,
          });
        } else if (tagMeta.server) {
          checks.push({
            surface: "mcp-entry",
            status: "pass",
            hard: false,
            actual: tagMeta.server.name,
            detail: `server.json present at ${tag} (no console script entry point found in the Python metadata)`,
          });
        } else {
          checks.push({
            surface: "mcp-entry",
            status: "skip",
            hard: false,
            detail: `No MCP server entry point (no *-mcp or server script, no server.json) at ${tag}`,
          });
        }
      }
    }
  }

  const hasNode = Boolean(tagMeta.pkg || mainMeta.pkg);
  const hasPython = pythonByMeta || pythonByTree;
  const ecosystem: GitHubOutcome["ecosystem"] = hasNode && hasPython
    ? "hybrid"
    : hasPython
      ? "python"
      : hasNode
        ? "node"
        : "unknown";
  return {
    checks,
    npmName,
    pypiName,
    serverName: serverAtTag?.name ?? mainMeta.server?.name,
    hasNode,
    hasPython,
    ecosystem,
  };
}

export interface NpmSurface {
  checks: SurfaceCheck[];
  latest?: string;
  exists: boolean;
}

export async function checkNpm(
  fetchFn: FetchFn,
  pkg: string,
  version: string,
): Promise<NpmSurface> {
  const url = `${NPM_API}/${pkg.replace("/", "%2F")}`;
  const res = await fetchFn(url, { headers: { "User-Agent": `shipcheck/${VERSION}` } });
  if (!res.ok) {
    const status: SurfaceCheck["status"] = res.status === 404 ? "fail" : "error";
    return {
      exists: false,
      checks: [
        {
          surface: "npm-version",
          status,
          hard: true,
          expected: `${pkg}@${version}`,
          detail:
            res.status === 404
              ? `Package ${pkg} is not on npm`
              : `npm registry returned ${res.status}`,
          source: `https://www.npmjs.com/package/${pkg}`,
        },
        {
          surface: "npm-latest",
          status,
          hard: true,
          expected: version,
          detail: "Cannot check latest without the package document",
        },
      ],
    };
  }
  const data = (await res.json().catch(() => null)) as {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, unknown>;
  } | null;
  const latest = data?.["dist-tags"]?.latest;
  const hasVersion = Boolean(data?.versions && version in data.versions);
  return {
    exists: true,
    latest,
    checks: [
      {
        surface: "npm-version",
        status: hasVersion ? "pass" : "fail",
        hard: true,
        expected: `${pkg}@${version}`,
        actual: hasVersion ? `${pkg}@${version}` : undefined,
        detail: hasVersion
          ? `${pkg}@${version} is published on npm`
          : `${pkg}@${version} is not published on npm (a staged hold looks exactly like this)`,
        source: `https://www.npmjs.com/package/${pkg}/v/${version}`,
      },
      {
        surface: "npm-latest",
        status: latest === version ? "pass" : "fail",
        hard: true,
        expected: version,
        actual: latest,
        detail:
          latest === version
            ? `npm latest points at ${version}`
            : `npm latest is ${latest ?? "unknown"}, expected ${version}`,
        source: `https://www.npmjs.com/package/${pkg}`,
      },
    ],
  };
}

export interface PypiSurface {
  checks: SurfaceCheck[];
  latest?: string;
  exists: boolean;
}

/**
 * Check one PyPI surface, mirroring checkNpm. One deliberate difference,
 * shared with the MCP Registry checks: a package that is absent from PyPI
 * reports SKIP, not FAIL, because many Python projects ship only through
 * GitHub releases, GHCR or an npm wrapper (wallcheck is one) and never
 * publish to PyPI at all. A package that IS on PyPI is held to the same
 * standard as npm: the version must exist with files, and the latest
 * release must be the expected version.
 */
export async function checkPypi(
  fetchFn: FetchFn,
  pkg: string,
  version: string,
): Promise<PypiSurface> {
  const url = `${PYPI_API}/pypi/${encodeURIComponent(pkg)}/json`;
  const source = `https://pypi.org/project/${pkg}/`;
  const res = await fetchFn(url, { headers: { "User-Agent": `shipcheck/${VERSION}` } });
  if (!res.ok) {
    if (res.status === 404) {
      return {
        exists: false,
        checks: [
          {
            surface: "pypi-version",
            status: "skip",
            hard: true,
            expected: `${pkg}==${version}`,
            detail: `Package ${pkg} is not on PyPI, PyPI checks do not apply`,
            source,
          },
          {
            surface: "pypi-latest",
            status: "skip",
            hard: true,
            detail: "No PyPI package to check latest against",
          },
        ],
      };
    }
    return {
      exists: false,
      checks: [
        {
          surface: "pypi-version",
          status: "error",
          hard: true,
          expected: `${pkg}==${version}`,
          detail: `PyPI returned ${res.status}`,
          source,
        },
        {
          surface: "pypi-latest",
          status: "error",
          hard: true,
          expected: version,
          detail: "Cannot check latest without the package document",
        },
      ],
    };
  }
  const data = (await res.json().catch(() => null)) as {
    info?: { version?: string };
    releases?: Record<string, { yanked?: boolean }[]>;
  } | null;
  const latest = data?.info?.version;
  const releases = data?.releases ?? {};
  const wanted = normalizePypiVersion(version);
  const releaseKey = Object.keys(releases).find((k) => normalizePypiVersion(k) === wanted);
  const files = releaseKey ? releases[releaseKey] : undefined;
  const hasVersion = Boolean(files && files.length > 0);
  return {
    exists: true,
    latest,
    checks: [
      {
        surface: "pypi-version",
        status: hasVersion ? "pass" : "fail",
        hard: true,
        expected: `${pkg}==${version}`,
        actual: hasVersion ? `${pkg}==${releaseKey}` : undefined,
        detail: hasVersion
          ? `${pkg} ${releaseKey} is published on PyPI with ${files?.length} file(s)`
          : files
            ? `${pkg} ${releaseKey} is listed on PyPI but has no files (yanked or placeholder release)`
            : `${pkg} ${version} is not published on PyPI`,
        source: `https://pypi.org/project/${pkg}/${version}/`,
      },
      {
        surface: "pypi-latest",
        status:
          latest && normalizePypiVersion(latest) === wanted ? "pass" : "fail",
        hard: true,
        expected: version,
        actual: latest,
        detail:
          latest && normalizePypiVersion(latest) === wanted
            ? `PyPI latest release is ${latest}`
            : `PyPI latest release is ${latest ?? "unknown"}, expected ${version}`,
        source,
      },
    ],
  };
}

interface RegistryEntry {
  version?: string;
  isLatest?: boolean;
  status?: string;
}

export function parseRegistryVersions(data: unknown): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  const push = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") return;
    const e = raw as Record<string, unknown>;
    const server = (e.server ?? e) as Record<string, unknown>;
    const meta = (e._meta ?? {}) as Record<string, unknown>;
    const official = (meta["io.modelcontextprotocol.registry/official"] ?? {}) as Record<
      string,
      unknown
    >;
    entries.push({
      version: typeof server.version === "string" ? server.version : undefined,
      isLatest: official.isLatest === true,
      status: typeof official.status === "string" ? official.status : undefined,
    });
  };
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (Array.isArray(d.servers)) for (const s of d.servers) push(s);
    else if (d.server || d.version) push(d);
  }
  return entries;
}

export async function checkRegistry(
  fetchFn: FetchFn,
  serverName: string,
  version: string,
): Promise<SurfaceCheck[]> {
  const source = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(serverName)}/versions`;
  let res = await fetchFn(source, { headers: { "User-Agent": `shipcheck/${VERSION}` } });
  let data: unknown = res.ok ? await res.json().catch(() => null) : null;
  if (!res.ok || !data) {
    // Fallback: search by the trailing name segment and filter exactly.
    const tail = serverName.split("/").pop() ?? serverName;
    const searchUrl = `${REGISTRY_API}/v0.1/servers?search=${encodeURIComponent(tail)}`;
    const sres = await fetchFn(searchUrl, { headers: { "User-Agent": `shipcheck/${VERSION}` } });
    if (sres.ok) {
      const sdata = (await sres.json().catch(() => null)) as Record<string, unknown> | null;
      const servers = Array.isArray(sdata?.servers) ? sdata.servers : [];
      const mine = servers.filter((s) => {
        const srv = (s as Record<string, unknown>).server as Record<string, unknown> | undefined;
        return srv?.name === serverName;
      });
      if (mine.length > 0) data = { servers: mine };
    }
  }
  const entries = parseRegistryVersions(data);
  if (entries.length === 0) {
    return [
      {
        surface: "registry-version",
        status: "skip",
        hard: true,
        detail: `Server ${serverName} is not in the MCP Registry, registry checks do not apply`,
        source,
      },
      {
        surface: "registry-latest",
        status: "skip",
        hard: true,
        detail: "No registry entry to check latest against",
      },
    ];
  }
  const match = entries.find((e) => e.version && normalizeVersion(e.version) === version);
  const latestEntry = entries.find((e) => e.isLatest);
  return [
    {
      surface: "registry-version",
      status: match ? "pass" : "fail",
      hard: true,
      expected: version,
      actual: entries.map((e) => e.version).filter(Boolean).join(", "),
      detail: match
        ? `MCP Registry lists ${serverName} ${version} (status ${match.status ?? "unknown"})`
        : `MCP Registry does not list ${serverName} ${version}`,
      source,
    },
    {
      surface: "registry-latest",
      status:
        latestEntry?.version && normalizeVersion(latestEntry.version) === version
          ? "pass"
          : "fail",
      hard: true,
      expected: version,
      actual: latestEntry?.version,
      detail:
        latestEntry?.version && normalizeVersion(latestEntry.version) === version
          ? `MCP Registry latest is ${version} and active`
          : `MCP Registry latest is ${latestEntry?.version ?? "unknown"}, expected ${version}. Registry publish must run after npm verifies.`,
      source,
    },
  ];
}

export async function checkGhcr(
  fetchFn: FetchFn,
  image: string,
  version: string,
): Promise<SurfaceCheck[]> {
  // image: ghcr.io/owner/repo
  const path = image.replace(/^ghcr\.io\//, "");
  const source = `https://github.com/${path.split("/")[0]}/packages/container/package/${path.split("/").slice(1).join("%2F")}`;
  const tokenRes = await fetchFn(
    `https://ghcr.io/token?service=ghcr.io&scope=repository:${path}:pull`,
    { headers: { "User-Agent": `shipcheck/${VERSION}` } },
  );
  if (!tokenRes.ok) {
    return [
      {
        surface: "ghcr-tag",
        status: "skip",
        hard: false,
        detail: `No public GHCR image at ${image} (token request returned ${tokenRes.status}), GHCR checks do not apply`,
        source,
      },
      { surface: "ghcr-latest", status: "skip", hard: false, detail: "No GHCR image to check" },
    ];
  }
  const tokenData = (await tokenRes.json().catch(() => null)) as { token?: string } | null;
  const tagsRes = await fetchFn(`https://ghcr.io/v2/${path}/tags/list`, {
    headers: {
      "User-Agent": `shipcheck/${VERSION}`,
      ...(tokenData?.token ? { Authorization: `Bearer ${tokenData.token}` } : {}),
      Accept: "application/json",
    },
  });
  if (!tagsRes.ok) {
    return [
      {
        surface: "ghcr-tag",
        status: "skip",
        hard: false,
        detail: `GHCR tags lookup returned ${tagsRes.status} for ${image}, treating GHCR as not applicable`,
        source,
      },
      { surface: "ghcr-latest", status: "skip", hard: false, detail: "No GHCR tags to check" },
    ];
  }
  const tagsData = (await tagsRes.json().catch(() => null)) as { tags?: string[] } | null;
  const tags = tagsData?.tags ?? [];
  return [
    {
      surface: "ghcr-tag",
      status: tags.includes(version) ? "pass" : "fail",
      hard: false,
      expected: `${image}:${version}`,
      actual: tags.slice(0, 20).join(", "),
      detail: tags.includes(version)
        ? `GHCR image has tag ${version}`
        : `GHCR image has no tag ${version}`,
      source,
    },
    {
      surface: "ghcr-latest",
      status: tags.includes("latest") ? "pass" : "fail",
      hard: false,
      expected: `${image}:latest`,
      detail: tags.includes("latest")
        ? "GHCR image has a latest tag"
        : "GHCR image has no latest tag",
      source,
    },
  ];
}

/** Full check across every surface. */
export async function checkRelease(
  fetchFn: FetchFn,
  repoRef: string,
  versionInput: string | undefined,
  opts: CheckOptions = {},
): Promise<ShipReport> {
  const { owner, repo } = parseRepoRef(repoRef);
  const token = opts.githubToken ?? process.env.GITHUB_TOKEN;
  const skip = expandSurfaces(opts.skip);
  const requireSet = expandSurfaces(opts.require);

  const branch = await getDefaultBranch(fetchFn, owner, repo, token);
  const mainMeta = await fetchRefMetadata(fetchFn, owner, repo, branch, token);

  let version: string;
  if (versionInput) {
    version = normalizeVersion(versionInput);
  } else if (mainMeta.pkg?.version) {
    version = normalizeVersion(mainMeta.pkg.version);
  } else {
    const py = await collectPythonVersions(fetchFn, owner, repo, branch, mainMeta, token);
    if (py.found.length === 0) {
      throw new Error(
        `Could not read a version from package.json, pyproject.toml, setup.cfg or setup.py on ${owner}/${repo}@${branch}. Pass a version explicitly.`,
      );
    }
    version = normalizeVersion(py.found[0].version);
  }

  const gh = await checkGitHub(fetchFn, owner, repo, version, skip, mainMeta, token);
  const checks: SurfaceCheck[] = [...gh.checks];

  // npm applies when the caller named a package or a package.json exists at
  // the tag or on the default branch. For a Python project with neither,
  // npm reports SKIP instead of the old false FAIL; for any other repo the
  // historical behaviour (check the conventional package name) is kept.
  const npmApplies = Boolean(opts.npmPackage) || gh.hasNode;
  if (!skip.has("npm-version") || !skip.has("npm-latest")) {
    if (npmApplies) {
      const npmPkg = opts.npmPackage ?? gh.npmName ?? `@reneturcios/${repo}`;
      const npm = await checkNpm(fetchFn, npmPkg, version);
      for (const c of npm.checks) if (!skip.has(c.surface)) checks.push(c);
    } else if (gh.hasPython) {
      if (!skip.has("npm-version")) {
        checks.push({
          surface: "npm-version",
          status: "skip",
          hard: false,
          detail: `No package.json at v${version} or on ${branch}, npm does not apply to this Python project`,
        });
      }
      if (!skip.has("npm-latest")) {
        checks.push({
          surface: "npm-latest",
          status: "skip",
          hard: false,
          detail: "No npm package to check latest against",
        });
      }
    } else {
      const npm = await checkNpm(fetchFn, `@reneturcios/${repo}`, version);
      for (const c of npm.checks) if (!skip.has(c.surface)) checks.push(c);
    }
  }

  // PyPI applies to Python projects (or when the caller names a package).
  if (opts.pypiPackage || gh.hasPython) {
    if (!skip.has("pypi-version") || !skip.has("pypi-latest")) {
      const pypiPkg = opts.pypiPackage ?? gh.pypiName ?? repo;
      const pypi = await checkPypi(fetchFn, pypiPkg, version);
      for (const c of pypi.checks) if (!skip.has(c.surface)) checks.push(c);
    }
  }

  const serverName = opts.serverName ?? gh.serverName ?? `io.github.${owner}/${repo}`;
  if (!skip.has("registry-version") || !skip.has("registry-latest")) {
    const reg = await checkRegistry(fetchFn, serverName, version);
    for (const c of reg) if (!skip.has(c.surface)) checks.push(c);
  }

  const ghcrImage = opts.ghcrImage ?? `ghcr.io/${owner.toLowerCase()}/${repo.toLowerCase()}`;
  if (!skip.has("ghcr-tag") || !skip.has("ghcr-latest")) {
    const ghcr = await checkGhcr(fetchFn, ghcrImage, version);
    for (const c of ghcr) if (!skip.has(c.surface)) checks.push(c);
  }

  if (requireSet.size > 0) {
    for (const c of checks) if (requireSet.has(c.surface)) c.hard = true;
  }

  // Stable surface order for readable output.
  const order = [
    "git-tag",
    "tag-commit",
    "tag-version",
    "pyproject-version",
    "server-version",
    "github-release",
    "npm-version",
    "npm-latest",
    "pypi-version",
    "pypi-latest",
    "registry-version",
    "registry-latest",
    "ghcr-tag",
    "ghcr-latest",
    "python-tests",
    "dockerfile",
    "readme",
    "mcp-entry",
  ];
  checks.sort((a, b) => order.indexOf(a.surface) - order.indexOf(b.surface));

  return {
    repo: `${owner}/${repo}`,
    version,
    verdict: computeVerdict(checks),
    checks,
    checkedAt: new Date().toISOString(),
    ecosystem: gh.ecosystem,
  };
}

export function renderReport(report: ShipReport): string {
  const lines: string[] = [];
  lines.push(`shipcheck ${report.repo} v${report.version}: ${report.verdict}`);
  for (const c of report.checks) {
    const mark =
      c.status === "pass" ? "PASS" : c.status === "fail" ? "FAIL" : c.status === "error" ? "ERROR" : "SKIP";
    lines.push(`  [${mark}] ${c.surface}: ${c.detail}`);
  }
  const hardFails = report.checks.filter(
    (c) => c.hard && (c.status === "fail" || c.status === "error"),
  );
  if (report.verdict === "GO") {
    lines.push("GO: every hard surface agrees on this version.");
  } else {
    lines.push(
      `NO-GO: ${hardFails.length} hard surface(s) disagree: ${hardFails.map((c) => c.surface).join(", ")}`,
    );
  }
  return lines.join("\n");
}
