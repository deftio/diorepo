#!/usr/bin/env node

// diorepo.js — Cross-repo dashboard CLI for deftio projects
// Node 18+ required (uses built-in fetch). Zero dependencies.
//
// The project list lives in projects.json, which is also what index.html reads.
// Registry lookups are opt-in per project: a repo is only queried on a registry
// it declares. Run with --format json --output data.json to produce the file the
// dashboard renders from.

const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const CONFIG_PATH = join(__dirname, 'projects.json');

function loadProjects() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!Array.isArray(cfg.projects)) throw new Error('missing "projects" array');
    return { owner: cfg.owner || 'deftio', projects: cfg.projects };
  } catch (err) {
    console.error(`Could not read ${CONFIG_PATH}: ${err.message}`);
    process.exit(1);
  }
}

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    projects: null,
    format: 'md',
    output: null,
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--projects':
        opts.projects = args[++i]?.split(',').map(s => s.trim());
        break;
      case '--format':
        opts.format = args[++i] || 'md';
        break;
      case '--output':
        opts.output = args[++i];
        break;
      case '--token':
        opts.token = args[++i];
        break;
      case '--help':
      case '-h':
        console.log(`diorepo — Cross-repo dashboard for deftio projects

Usage:
  node diorepo.js                              # All projects, markdown to stdout
  node diorepo.js --projects bitwrench,fr_math # Filter projects
  node diorepo.js --format json|csv|md         # Output format (default: md)
  node diorepo.js --output report.md           # Write to file
  node diorepo.js --token ghp_xxx              # GitHub token (or set GITHUB_TOKEN)

Projects are configured in projects.json.
JSON output includes per-project releases and open issues, and is what
index.html renders from — regenerate it with:
  node diorepo.js --format json --output data.json
`);
        process.exit(0);
    }
  }
  return opts;
}

// Every "missing" value in this tool looks identical whether the upstream
// genuinely has nothing or we simply got throttled. Without a token GitHub
// allows 60 requests/hour, which one full run blows through — and the result is
// a snapshot of dashes that looks like real data. Track throttling explicitly so
// a degraded run can refuse to overwrite a good data.json.
let rateLimited = false;

function noteRateLimit(resp) {
  if ((resp.status === 403 || resp.status === 429) &&
      resp.headers.get('x-ratelimit-remaining') === '0') {
    rateLimited = true;
  }
}

// Fetch helper
async function fetchJSON(url, token) {
  const headers = { 'User-Agent': 'diorepo-cli' };
  if (token) headers['Authorization'] = `token ${token}`;
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) { noteRateLimit(resp); return null; }
    return await resp.json();
  } catch { return null; }
}

async function fetchContributorCount(repo, token) {
  const headers = { 'User-Agent': 'diorepo-cli' };
  if (token) headers['Authorization'] = `token ${token}`;
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/contributors?per_page=1&anon=1`, { headers });
    if (!resp.ok) { noteRateLimit(resp); return null; }
    const link = resp.headers.get('link');
    if (link) {
      const match = link.match(/page=(\d+)>; rel="last"/);
      if (match) return parseInt(match[1]);
    }
    const data = await resp.json();
    return Array.isArray(data) ? data.length : null;
  } catch { return null; }
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// GitHub's search API is limited to 30 requests/minute even when authenticated —
// far tighter than the 5000/hour core limit — so search calls are paced at one
// per SEARCH_INTERVAL_MS and retried with backoff when we still get throttled.
const SEARCH_INTERVAL_MS = 2100;

async function fetchSearchCount(query, token) {
  const url = `https://api.github.com/search/issues?q=${query}&per_page=1`;
  const headers = { 'User-Agent': 'diorepo-cli' };
  if (token) headers['Authorization'] = `token ${token}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    let resp;
    try {
      resp = await fetch(url, { headers });
    } catch {
      return null;
    }
    if (resp.ok) {
      const data = await resp.json();
      return data.total_count ?? 0;
    }
    if (resp.status !== 403 && resp.status !== 429) return null;

    // Throttled: wait for the window the response tells us to wait for.
    const retryAfter = Number(resp.headers.get('retry-after')) * 1000;
    const reset = Number(resp.headers.get('x-ratelimit-reset')) * 1000;
    const untilReset = reset ? reset - Date.now() + 1000 : 0;
    await sleep(Math.min(Math.max(retryAfter || untilReset || 5000, 1000), 65000));
  }

  rateLimited = true;
  return null;
}

// Sort dotted version strings numerically ("1.10.0" > "1.9.0").
function compareVersions(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// The Arduino Library Manager has no public version API, so we scrape its
// per-repo build log and pull the highest version it reports having ingested.
// FRAGILE BY NATURE: if Arduino changes the log wording, this silently returns
// '—' rather than a wrong number. Check the log URL by hand if a known-published
// library starts showing no version.
async function fetchArduinoVersion(repo) {
  try {
    const resp = await fetch(`https://downloads.arduino.cc/libraries/logs/github.com/${repo}/`, {
      headers: { 'User-Agent': 'diorepo-cli' }
    });
    if (!resp.ok) return '—';
    const text = await resp.text();
    const versions = [...text.matchAll(/Release .+?:([\d.]+) already loaded/g)].map(m => m[1]);
    if (versions.length === 0) return '—';
    versions.sort(compareVersions);
    return versions[versions.length - 1];
  } catch {
    return '—';
  }
}

async function fetchAllData(projects, token) {
  const results = projects.map(p => ({
    ...p,
    stars: null,
    contributors: null,
    openIssues: null,
    totalIssues: null,
    downloads: null,
    npmDownloads: 0,
    pypiDownloads: 0,
    npmVersion: '—',
    pypiVersion: '—',
    arduinoVersion: '—',
    platformioVersion: '—',
    espressifVersion: '—',
    githubTag: null,
    description: null,
    language: null,
    releases: [],
    recentIssues: [],
  }));

  process.stderr.write('Fetching GitHub repo data, registries, tags...\n');

  await Promise.all(results.map(async (r) => {
    // Repo metadata — fetched per repo rather than from the owner's repo
    // listing, which silently truncates past 100 repos.
    const repo = await fetchJSON(`https://api.github.com/repos/${r.github}`, token);
    if (repo) {
      r.stars = repo.stargazers_count;
      r.description = repo.description || '';
      r.language = repo.language || '';
    }

    // Contributors
    r.contributors = await fetchContributorCount(r.github, token);

    // GitHub tag
    const rel = await fetchJSON(`https://api.github.com/repos/${r.github}/releases/latest`, token);
    if (rel && rel.tag_name) {
      r.githubTag = rel.tag_name;
    } else {
      const tags = await fetchJSON(`https://api.github.com/repos/${r.github}/tags?per_page=1`, token);
      r.githubTag = (tags && tags.length > 0) ? tags[0].name : '—';
    }

    // Recent releases and open issues (used by the dashboard's detail rows)
    const releases = await fetchJSON(`https://api.github.com/repos/${r.github}/releases?per_page=5`, token);
    r.releases = (releases || []).map(x => ({
      tag_name: x.tag_name, published_at: x.published_at, html_url: x.html_url
    }));

    const issues = await fetchJSON(`https://api.github.com/repos/${r.github}/issues?state=open&per_page=10`, token);
    r.recentIssues = (issues || [])
      .filter(i => !i.pull_request)
      .slice(0, 5)
      .map(i => ({ number: i.number, title: i.title, html_url: i.html_url }));

    // Registry lookups are opt-in — a project is only queried on registries it
    // declares in projects.json. Guessing by repo name both wasted a round trip
    // per project per registry and occasionally matched an unrelated package
    // published by someone else under the same name.
    if (r.npm) {
      const reg = await fetchJSON(`https://registry.npmjs.org/${r.npm}`);
      r.npmVersion = (reg && reg['dist-tags']) ? reg['dist-tags'].latest : '—';
      const dl = await fetchJSON(`https://api.npmjs.org/downloads/point/last-week/${r.npm}`);
      r.npmDownloads = (dl && dl.downloads !== undefined) ? dl.downloads : 0;
    }

    if (r.pypi) {
      const pypi = await fetchJSON(`https://pypi.org/pypi/${r.pypi}/json`);
      if (pypi && pypi.info) {
        r.pypiVersion = pypi.info.version;
        const stats = await fetchJSON(`https://pypistats.org/api/packages/${r.pypi}/recent`);
        r.pypiDownloads = (stats && stats.data && stats.data.last_week) ? stats.data.last_week : 0;
      }
    }

    if (r.platformio) {
      const pioOwner = r.github.split('/')[0];
      const pio = await fetchJSON(`https://api.registry.platformio.org/v3/packages/${pioOwner}/library/${r.platformio}`);
      r.platformioVersion = (pio && pio.version) ? (pio.version.name || pio.version) : '—';
    }

    if (r.espressif) {
      const espNs = r.github.split('/')[0];
      const esp = await fetchJSON(`https://components.espressif.com/api/components/${espNs}/${r.espressif}`);
      r.espressifVersion = (esp && esp.versions && esp.versions.length > 0) ? esp.versions[0].version : '—';
    }

    if (r.arduino) {
      r.arduinoVersion = await fetchArduinoVersion(r.github);
    }

    // Aggregate downloads
    const totalDl = r.npmDownloads + r.pypiDownloads;
    r.downloads = totalDl > 0 ? totalDl : '—';
  }));

  // Issue counts via search API, which — unlike the REST issues endpoint —
  // excludes pull requests. Sequential and paced; see SEARCH_INTERVAL_MS.
  const searchCalls = results.length * 2;
  process.stderr.write(`Fetching issue counts (${searchCalls} paced search calls, ~${Math.round(searchCalls * SEARCH_INTERVAL_MS / 1000)}s)...\n`);
  for (const r of results) {
    const open = await fetchSearchCount(`repo:${r.github}+is:issue+is:open`, token);
    r.openIssues = open ?? 0;
    await sleep(SEARCH_INTERVAL_MS);

    const closed = await fetchSearchCount(`repo:${r.github}+is:issue+is:closed`, token);
    r.totalIssues = r.openIssues + (closed ?? 0);
    await sleep(SEARCH_INTERVAL_MS);
  }

  return results;
}

// Formatters
const TABLE_HEADERS = ['Project', 'Stars', 'Contributors', 'Open Issues', 'Total Issues', 'Downloads', 'npm', 'PyPI', 'Arduino', 'PlatformIO', 'Espressif', 'GitHub Tag'];
const CSV_HEADERS = ['project', 'stars', 'contributors', 'open_issues', 'total_issues', 'downloads', 'npm', 'pypi', 'arduino', 'platformio', 'espressif', 'github_tag'];

function toRow(r, empty) {
  return [
    r.name, r.stars ?? empty, r.contributors ?? empty, r.openIssues ?? empty,
    r.totalIssues ?? empty, r.downloads ?? empty, r.npmVersion ?? empty,
    r.pypiVersion ?? empty, r.arduinoVersion ?? empty, r.platformioVersion ?? empty,
    r.espressifVersion ?? empty, r.githubTag ?? empty
  ];
}

function formatMD(data) {
  const rows = data.map(r => toRow(r, '—'));
  const colWidths = TABLE_HEADERS.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const pad = (s, w) => String(s).padEnd(w);

  return [
    '| ' + TABLE_HEADERS.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |',
    '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |',
    ...rows.map(r => '| ' + r.map((c, i) => pad(c, colWidths[i])).join(' | ') + ' |')
  ].join('\n');
}

// RFC 4180: wrap in quotes, and escape embedded quotes by doubling them.
function csvCell(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function formatCSV(data) {
  const rows = data.map(r => toRow(r, ''));
  return [CSV_HEADERS.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n');
}

function formatJSON(data, generated) {
  return JSON.stringify({
    generated,
    projects: data.map(r => ({
      project: r.name,
      github: r.github,
      description: r.description,
      language: r.language,
      stars: r.stars,
      contributors: r.contributors,
      open_issues: r.openIssues,
      total_issues: r.totalIssues,
      downloads: r.downloads,
      npm_downloads: r.npmDownloads,
      pypi_downloads: r.pypiDownloads,
      npm: r.npmVersion,
      pypi: r.pypiVersion,
      arduino: r.arduinoVersion,
      platformio: r.platformioVersion,
      espressif: r.espressifVersion,
      github_tag: r.githubTag,
      packages: {
        npm: r.npm || null,
        pypi: r.pypi || null,
        platformio: r.platformio || null,
        espressif: r.espressif || null,
      },
      releases: r.releases,
      recent_issues: r.recentIssues,
    }))
  }, null, 2);
}

// Main
async function main() {
  const opts = parseArgs();
  const { projects: allProjects } = loadProjects();

  let projects = allProjects;
  if (opts.projects) {
    const filter = opts.projects.map(s => s.toLowerCase());
    projects = allProjects.filter(p => filter.includes(p.name.toLowerCase()));
    if (projects.length === 0) {
      console.error('No matching projects found.');
      process.exit(1);
    }
  }

  if (!opts.token) {
    process.stderr.write('Note: no GitHub token set — expect rate limiting. Use --token or set GITHUB_TOKEN.\n');
  }

  const data = await fetchAllData(projects, opts.token);

  if (rateLimited) {
    console.error(
      '\nGitHub rate limit hit — results are incomplete, refusing to write.\n' +
      'Pass --token or set GITHUB_TOKEN (a plain read-only token is enough) and re-run.'
    );
    process.exit(1);
  }

  let output;
  switch (opts.format) {
    case 'json': output = formatJSON(data, new Date().toISOString()); break;
    case 'csv': output = formatCSV(data); break;
    case 'md': default: output = formatMD(data); break;
  }

  if (opts.output) {
    writeFileSync(opts.output, output + '\n');
    process.stderr.write(`Written to ${opts.output}\n`);
  } else {
    console.log(output);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
