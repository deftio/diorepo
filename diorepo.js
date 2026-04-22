#!/usr/bin/env node

// diorepo.js — Cross-repo dashboard CLI for deftio projects
// Node 18+ required (uses built-in fetch). Zero dependencies.

const PROJECTS = [
  { name: "bitwrench",    github: "deftio/bitwrench",    npm: "bitwrench" },
  { name: "fr_math",      github: "deftio/fr_math" },
  { name: "companders",   github: "deftio/companders",   npm: "companders" },
  { name: "quikdown",     github: "deftio/quikdown",     npm: "quikdown" },
  { name: "quikchat",     github: "deftio/quikchat",     npm: "quikchat" },
  { name: "xelp",         github: "deftio/xelp" },
  { name: "triepack",     github: "deftio/triepack",     npm: "triepack" },
  { name: "jsonvice",     github: "deftio/jsonvice",     npm: "jsonvice" },
  { name: "html-to-docx", github: "deftio/html-to-docx" },
  { name: "simpleJSLib",  github: "deftio/simpleJSLib" },
  { name: "jado",         github: "deftio/jado" },
  { name: "webwrench",    github: "deftio/webwrench" },
  { name: "pocketdock",   github: "deftio/pocketdock" },
  { name: "MirrorMirror", github: "deftio/MirrorMirror" },
  { name: "WebAudioSpectrum", github: "deftio/WebAudioSpectrum" },
  { name: "web-audio-latency-tester", github: "deftio/web-audio-latency-tester" },
  { name: "provisional-patent-template", github: "deftio/provisional-patent-template" },
  { name: "C-and-Cpp-Tests-with-CI-CD-Example", github: "deftio/C-and-Cpp-Tests-with-CI-CD-Example" },
];

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { projects: null, format: 'md', output: null, token: null };

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
  node diorepo.js --token ghp_xxx             # GitHub token for higher rate limits
`);
        process.exit(0);
    }
  }
  return opts;
}

// Fetch helper
async function fetchJSON(url, token) {
  const headers = { 'User-Agent': 'diorepo-cli' };
  if (token) headers['Authorization'] = `token ${token}`;
  try {
    const resp = await fetch(url, { headers });
    if (!resp.ok) return null;
    return await resp.json();
  } catch { return null; }
}

async function fetchContributorCount(repo, token) {
  const headers = { 'User-Agent': 'diorepo-cli' };
  if (token) headers['Authorization'] = `token ${token}`;
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/contributors?per_page=1&anon=1`, { headers });
    if (!resp.ok) return null;
    const link = resp.headers.get('link');
    if (link) {
      const match = link.match(/page=(\d+)>; rel="last"/);
      if (match) return parseInt(match[1]);
    }
    const data = await resp.json();
    return Array.isArray(data) ? data.length : null;
  } catch { return null; }
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
    npmVersion: null,
    pypiVersion: null,
    arduinoVersion: null,
    platformioVersion: null,
    espressifVersion: null,
    githubTag: null,
  }));

  process.stderr.write('Fetching GitHub repo data...\n');

  // Fetch all repos
  const repos = await fetchJSON('https://api.github.com/users/deftio/repos?per_page=100', token);
  if (repos) {
    for (const r of results) {
      const repoName = r.github.split('/')[1];
      const repo = repos.find(x => x.name === repoName);
      if (repo) {
        r.stars = repo.stargazers_count;
      }
    }
  }

  // Parallel fetches
  process.stderr.write('Fetching contributors, npm, PyPI, tags...\n');

  await Promise.all(results.map(async (r) => {
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

    // npm
    if (r.npm) {
      const reg = await fetchJSON(`https://registry.npmjs.org/${r.npm}`);
      r.npmVersion = (reg && reg['dist-tags']) ? reg['dist-tags'].latest : '—';
      const dl = await fetchJSON(`https://api.npmjs.org/downloads/point/last-week/${r.npm}`);
      r.npmDownloads = (dl && dl.downloads !== undefined) ? dl.downloads : 0;
    } else {
      r.npmVersion = '—';
    }

    // PyPI
    const pypiPkg = r.pypi || r.name;
    const pypi = await fetchJSON(`https://pypi.org/pypi/${pypiPkg}/json`);
    if (pypi && pypi.info) {
      r.pypiVersion = pypi.info.version;
      const stats = await fetchJSON(`https://pypistats.org/api/packages/${pypiPkg}/recent`);
      r.pypiDownloads = (stats && stats.data && stats.data.last_week) ? stats.data.last_week : 0;
    } else {
      r.pypiVersion = '—';
    }

    // Aggregate downloads
    const totalDl = r.npmDownloads + r.pypiDownloads;
    r.downloads = totalDl > 0 ? totalDl : '—';

    // PlatformIO
    const pioOwner = r.github.split('/')[0];
    const pioName = r.platformio || r.name;
    const pio = await fetchJSON(`https://api.registry.platformio.org/v3/packages/${pioOwner}/library/${pioName}`);
    r.platformioVersion = (pio && pio.version) ? (pio.version.name || pio.version) : '—';

    // Espressif
    const espNs = r.github.split('/')[0];
    const espName = r.espressif || r.name;
    const esp = await fetchJSON(`https://components.espressif.com/api/components/${espNs}/${espName}`);
    r.espressifVersion = (esp && esp.versions && esp.versions.length > 0) ? esp.versions[0].version : '—';

    // Arduino (check master then main for library.properties)
    r.arduinoVersion = '—';
    for (const branch of ['master', 'main']) {
      try {
        const resp = await fetch(`https://raw.githubusercontent.com/${r.github}/${branch}/library.properties`, {
          headers: { 'User-Agent': 'diorepo-cli' }
        });
        if (resp.ok) {
          const text = await resp.text();
          const match = text.match(/version=(.*)/);
          r.arduinoVersion = match ? match[1].trim() : 'Yes';
          break;
        }
      } catch { /* try next branch */ }
    }
  }));

  // Issue counts via search API (excludes PRs, sequential to avoid rate limit)
  process.stderr.write('Fetching issue counts...\n');
  for (const r of results) {
    const repoName = r.github.split('/')[1];
    const open = await fetchJSON(`https://api.github.com/search/issues?q=repo:deftio/${repoName}+is:issue+is:open`, token);
    r.openIssues = (open && open.total_count !== undefined) ? open.total_count : 0;
    await new Promise(resolve => setTimeout(resolve, 400));

    const closed = await fetchJSON(`https://api.github.com/search/issues?q=repo:deftio/${repoName}+is:issue+is:closed`, token);
    const closedCount = (closed && closed.total_count !== undefined) ? closed.total_count : 0;
    r.totalIssues = r.openIssues + closedCount;
    await new Promise(resolve => setTimeout(resolve, 400));
  }

  return results;
}

// Formatters
function formatMD(data) {
  const headers = ['Project', 'Stars', 'Contributors', 'Open Issues', 'Total Issues', 'Downloads', 'npm', 'PyPI', 'Arduino', 'PlatformIO', 'Espressif', 'GitHub Tag'];
  const rows = data.map(r => [
    r.name, r.stars ?? '—', r.contributors ?? '—', r.openIssues ?? '—',
    r.totalIssues ?? '—', r.downloads ?? '—', r.npmVersion ?? '—',
    r.pypiVersion ?? '—', r.arduinoVersion ?? '—', r.platformioVersion ?? '—',
    r.espressifVersion ?? '—', r.githubTag ?? '—'
  ]);

  const colWidths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => String(r[i]).length)));
  const pad = (s, w) => String(s).padEnd(w);

  const lines = [
    '| ' + headers.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |',
    '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |',
    ...rows.map(r => '| ' + r.map((c, i) => pad(c, colWidths[i])).join(' | ') + ' |')
  ];
  return lines.join('\n');
}

function formatCSV(data) {
  const headers = ['project', 'stars', 'contributors', 'open_issues', 'total_issues', 'downloads', 'npm', 'pypi', 'arduino', 'platformio', 'espressif', 'github_tag'];
  const rows = data.map(r => [
    r.name, r.stars ?? '', r.contributors ?? '', r.openIssues ?? '',
    r.totalIssues ?? '', r.downloads ?? '', r.npmVersion ?? '',
    r.pypiVersion ?? '', r.arduinoVersion ?? '', r.platformioVersion ?? '',
    r.espressifVersion ?? '', r.githubTag ?? ''
  ]);
  return [headers.join(','), ...rows.map(r => r.map(c => `"${c}"`).join(','))].join('\n');
}

function formatJSON(data) {
  return JSON.stringify(data.map(r => ({
    project: r.name,
    stars: r.stars,
    contributors: r.contributors,
    open_issues: r.openIssues,
    total_issues: r.totalIssues,
    downloads: r.downloads,
    npm: r.npmVersion,
    pypi: r.pypiVersion,
    arduino: r.arduinoVersion,
    platformio: r.platformioVersion,
    espressif: r.espressifVersion,
    github_tag: r.githubTag
  })), null, 2);
}

// Main
async function main() {
  const opts = parseArgs();

  let projects = PROJECTS;
  if (opts.projects) {
    const filter = opts.projects.map(s => s.toLowerCase());
    projects = PROJECTS.filter(p => filter.includes(p.name.toLowerCase()));
    if (projects.length === 0) {
      console.error('No matching projects found.');
      process.exit(1);
    }
  }

  const data = await fetchAllData(projects, opts.token);

  let output;
  switch (opts.format) {
    case 'json': output = formatJSON(data); break;
    case 'csv': output = formatCSV(data); break;
    case 'md': default: output = formatMD(data); break;
  }

  if (opts.output) {
    const { writeFileSync } = await import('node:fs');
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
