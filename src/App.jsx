import { useState, useRef } from 'react';
import './App.css';

const TABS = [
  { id: 'compare', label: 'Compare Packs' },
  { id: 'server', label: 'Build Server Pack' },
];

const CATEGORY_LABELS = {
  keep: '✓ Server-compatible',
  exclude: '✕ Client-only (excluded)',
  review: '? Needs review',
};

function App() {
  const [activeTab, setActiveTab] = useState('compare');
  const tabRefs = useRef({});

  // ---- Compare tab state ----
  const [oldJson, setOldJson] = useState('');
  const [newJson, setNewJson] = useState('');
  const [oldFile, setOldFile] = useState(null);
  const [newFile, setNewFile] = useState(null);
  const [markdownText, setMarkdownText] = useState('');
  const [changeSummary, setChangeSummary] = useState(null);
  const [copied, setCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  // ---- Server pack tab state ----
  const [serverFile, setServerFile] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isDownloadingServer, setIsDownloadingServer] = useState(false);
  const [analyzedMods, setAnalyzedMods] = useState(null);
  const analysisRef = useRef({ zip: null, manifest: null });

  // ---- Shared status/error banner ----
  const [error, setError] = useState(null);

  const normalizeName = (name) =>
    String(name ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

  const escapeHtml = (str) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const renderMarkdownToHTML = (md) => {
    if (!md) return '';

    const escaped = escapeHtml(md);
    const lines = escaped.split(/\r?\n/);

    let html = '';
    let inList = false;

    lines.forEach((raw) => {
      const line = raw.trimEnd();

      if (/^#{1,6}\s+/.test(line)) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        const level = line.match(/^#{1,6}/)[0].length;
        const text = line.replace(/^#{1,6}\s+/, '');
        html += `<h${level}>${text}</h${level}>`;
      } else if (/^-\s+/.test(line)) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        const text = line.replace(/^-\s+/, '');
        html += `<li>${text}</li>`;
      } else if (line === '') {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        html += '<p></p>';
      } else {
        html += `<p>${line}</p>`;
      }
    });

    if (inList) {
      html += '</ul>';
    }

    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    return html;
  };

  const generateMarkdown = (data) => {
    const sections = [];

    const fmtLink = (mod) =>
      mod.url ? `[${mod.name}](${mod.url})` : `**${mod.name}**`;

    const fmtVer = (v) => (v ? '`' + v + '`' : '');

    const sortByName = (arr) =>
      arr
        .slice()
        .sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));

    if (data.added && data.added.length > 0) {
      const items = sortByName(data.added);
      sections.push({
        title: `Added (${items.length})`,
        lines: items.map((m) => `- ${fmtLink(m)} ${fmtVer(m.version)}`),
      });
    }

    if (data.updated && data.updated.length > 0) {
      const items = sortByName(data.updated);
      sections.push({
        title: `Updated (${items.length})`,
        lines: items.map(
          (m) => `- ${fmtLink(m)}: ${fmtVer(m.oldVersion)} → ${fmtVer(m.version)}`
        ),
      });
    }

    if (data.removed && data.removed.length > 0) {
      const items = sortByName(data.removed);
      sections.push({
        title: `Removed (${items.length})`,
        lines: items.map((m) => `- ${fmtLink(m)} ${fmtVer(m.version)}`),
      });
    }

    if (sections.length === 0) {
      return `No changes detected.\n`;
    }

    let markdown = '';
    sections.forEach((sec) => {
      markdown += `## ${sec.title}\n\n`;
      sec.lines.forEach((line) => {
        markdown += `${line}\n`;
      });
      markdown += '\n';
    });

    return markdown;
  };

  /*
   * ---- Modrinth API helpers ----
   * Shared by the changelog (name/version resolution) and the server
   * pack builder (client/server support classification).
   */
  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  };

  const fetchVersionsByHashes = async (hashes) => {
    if (hashes.length === 0) return {};
    const results = {};
    for (const batch of chunk(hashes, 200)) {
      const res = await fetch('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: batch, algorithm: 'sha1' }),
      });
      if (!res.ok) throw new Error(`Modrinth API error (${res.status})`);
      Object.assign(results, await res.json());
    }
    return results;
  };

  const fetchProjectsByIds = async (ids) => {
    if (ids.length === 0) return [];
    const results = [];
    for (const batch of chunk(ids, 200)) {
      const res = await fetch(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`
      );
      if (!res.ok) throw new Error(`Modrinth API error (${res.status})`);
      results.push(...(await res.json()));
    }
    return results;
  };

  const parseMrpack = async (file) => {
    if (!file) {
      throw new Error('No mrpack file selected.');
    }

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(file);
    const manifestFile = zip.file('modrinth.index.json');

    if (!manifestFile) {
      throw new Error(`${file.name} does not contain modrinth.index.json`);
    }

    const manifestText = await manifestFile.async('text');
    const manifest = JSON.parse(manifestText);

    if (!Array.isArray(manifest.files)) {
      throw new Error(`${file.name} contains an invalid Modrinth index`);
    }

    const entries = manifest.files.filter((entry) => entry && entry.path);

    const fallbackFor = (entry) => {
      const path = entry.path;
      const hashes = entry.hashes || {};
      const url =
        Array.isArray(entry.downloads) && entry.downloads.length > 0
          ? entry.downloads[0]
          : '';
      const filename = path.split('/').pop() || path;
      const name = filename.replace(/\.(jar|zip)$/i, '');
      const version = hashes.sha512 || hashes.sha1 || '';
      return { name, url, version };
    };

    const sha1ToEntry = new Map();
    entries.forEach((entry) => {
      const sha1 = entry.hashes?.sha1;
      if (sha1) sha1ToEntry.set(sha1, entry);
    });

    const hashes = Array.from(sha1ToEntry.keys());

    let versionByHash = {};
    try {
      versionByHash = await fetchVersionsByHashes(hashes);
    } catch (err) {
      console.error('Modrinth version lookup failed, using filenames/hashes:', err);
      return entries.map(fallbackFor);
    }

    const projectIds = Array.from(
      new Set(Object.values(versionByHash).map((v) => v.project_id).filter(Boolean))
    );

    let projects = [];
    try {
      projects = await fetchProjectsByIds(projectIds);
    } catch (err) {
      console.error('Modrinth project lookup failed, using version data only:', err);
    }

    const projectById = new Map(projects.map((p) => [p.id, p]));

    return entries.map((entry) => {
      const sha1 = entry.hashes?.sha1;
      const version = sha1 ? versionByHash[sha1] : null;

      if (!version) return fallbackFor(entry);

      const project = projectById.get(version.project_id);
      const url = project?.slug
        ? `https://modrinth.com/mod/${project.slug}`
        : Array.isArray(entry.downloads) && entry.downloads.length > 0
          ? entry.downloads[0]
          : '';

      return {
        name: project?.title || fallbackFor(entry).name,
        url,
        version: version.version_number || fallbackFor(entry).version,
      };
    });
  };

  const readInput = async (jsonText, file) => {
    if (file) return await parseMrpack(file);

    if (!jsonText.trim()) {
      throw new Error('No input provided.');
    }

    const parsed = JSON.parse(jsonText);

    if (!Array.isArray(parsed)) {
      throw new Error('JSON input must be an array.');
    }

    return parsed;
  };

  const generateChangelog = async () => {
    setIsGenerating(true);
    setError(null);
    setChangeSummary(null);

    try {
      const [oldMods, newMods] = await Promise.all([
        readInput(oldJson, oldFile),
        readInput(newJson, newFile),
      ]);

      const oldModsMap = new Map();
      oldMods.forEach((mod) => {
        const key = normalizeName(mod.name);
        if (key) oldModsMap.set(key, mod);
      });

      const newModsMap = new Map();
      newMods.forEach((mod) => {
        const key = normalizeName(mod.name);
        if (key) newModsMap.set(key, mod);
      });

      const added = [];
      const removed = [];
      const updated = [];

      newMods.forEach((newMod) => {
        const key = normalizeName(newMod.name);
        const oldMod = oldModsMap.get(key);

        if (!oldMod) {
          added.push(newMod);
        } else if (oldMod.version !== newMod.version) {
          updated.push({ ...newMod, oldVersion: oldMod.version });
        }
      });

      oldMods.forEach((oldMod) => {
        const key = normalizeName(oldMod.name);
        if (!newModsMap.has(key)) removed.push(oldMod);
      });

      setMarkdownText(generateMarkdown({ added, removed, updated }));
      setChangeSummary({ added: added.length, updated: updated.length, removed: removed.length });
    } catch (err) {
      setError(err.message || 'Invalid input. Please check your JSON or .mrpack file.');
      console.error(err);
    } finally {
      setIsGenerating(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(markdownText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError('Failed to copy to clipboard.');
      console.error(err);
    }
  };

  const handleOldFileChange = (event) => {
    setOldFile(event.target.files?.[0] || null);
  };

  const handleNewFileChange = (event) => {
    setNewFile(event.target.files?.[0] || null);
  };

  /*
   * ---- Server pack analysis ----
   * A file's `env.server` in modrinth.index.json is set by whoever
   * built the pack, and is frequently left as "required" by mistake
   * for mods that are actually client-only. Modrinth's own PROJECT
   * data (server_side, separate from the pack) is generally more
   * reliable, since it's set by the mod author on Modrinth itself.
   *
   * We classify each file using both signals:
   *  - pack says "unsupported"            -> exclude (author's own call)
   *  - Modrinth project says "unsupported" -> exclude (catches mods the
   *                                            pack mis-flagged)
   *  - either says required/optional       -> keep
   *  - neither gives a clear answer        -> "needs review" (custom or
   *                                            unlisted mods, or mods
   *                                            Modrinth itself marks
   *                                            "unknown"), left for you
   *                                            to decide, defaulted to
   *                                            "keep" so nothing is
   *                                            silently dropped.
   */
  const handleServerFileChange = (event) => {
    setServerFile(event.target.files?.[0] || null);
    setAnalyzedMods(null);
    analysisRef.current = { zip: null, manifest: null };
  };

  const analyzeServerPack = async () => {
    if (!serverFile) return;

    setIsAnalyzing(true);
    setError(null);
    setAnalyzedMods(null);

    try {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(serverFile);
      const manifestEntry = zip.file('modrinth.index.json');

      if (!manifestEntry) {
        throw new Error(`${serverFile.name} does not contain modrinth.index.json`);
      }

      const manifest = JSON.parse(await manifestEntry.async('text'));

      if (!Array.isArray(manifest.files)) {
        throw new Error(`${serverFile.name} contains an invalid Modrinth index`);
      }

      analysisRef.current = { zip, manifest };

      const entries = manifest.files.filter((e) => e && e.path);

      const sha1ToEntry = new Map();
      entries.forEach((entry) => {
        const sha1 = entry.hashes?.sha1;
        if (sha1) sha1ToEntry.set(sha1, entry);
      });
      const hashes = Array.from(sha1ToEntry.keys());

      let versionByHash = {};
      try {
        versionByHash = await fetchVersionsByHashes(hashes);
      } catch (err) {
        console.error('Modrinth version lookup failed during analysis:', err);
      }

      const projectIds = Array.from(
        new Set(Object.values(versionByHash).map((v) => v.project_id).filter(Boolean))
      );

      let projects = [];
      try {
        projects = await fetchProjectsByIds(projectIds);
      } catch (err) {
        console.error('Modrinth project lookup failed during analysis:', err);
      }

      const projectById = new Map(projects.map((p) => [p.id, p]));

      const results = entries.map((entry) => {
        const filename = entry.path.split('/').pop() || entry.path;
        const sha1 = entry.hashes?.sha1;
        const version = sha1 ? versionByHash[sha1] : null;
        const project = version ? projectById.get(version.project_id) : null;

        const displayName = project?.title || filename.replace(/\.(jar|zip)$/i, '');
        const url = project?.slug
          ? `https://modrinth.com/mod/${project.slug}`
          : Array.isArray(entry.downloads) && entry.downloads.length > 0
            ? entry.downloads[0]
            : '';
        const packEnvServer = entry.env?.server;
        const projectServer = project?.server_side;

        let category;
        let reason;

        if (packEnvServer === 'unsupported') {
          category = 'exclude';
          reason = 'Marked client-only by the pack';
        } else if (projectServer === 'unsupported') {
          category = 'exclude';
          reason = "Marked client-only on Modrinth (pack didn't flag it)";
        } else if (projectServer === 'required' || projectServer === 'optional') {
          category = 'keep';
          reason = 'Server-compatible on Modrinth';
        } else if (packEnvServer === 'required' || packEnvServer === 'optional') {
          category = 'keep';
          reason = 'Marked server-compatible by the pack';
        } else {
          category = 'review';
          reason = project
            ? 'Modrinth lists no server-support info for this mod'
            : 'Not resolvable on Modrinth (custom or local file)';
        }

        return {
          id: entry.path,
          name: displayName,
          filename,
          path: entry.path,
          url,
          category,
          reason,
          included: category !== 'exclude',
        };
      });

      results.sort((a, b) => a.name.localeCompare(b.name));

      setAnalyzedMods(results);
    } catch (err) {
      setError(err.message || 'Failed to analyze pack.');
      console.error(err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const toggleModIncluded = (id) => {
    setAnalyzedMods((prev) =>
      prev.map((m) => (m.id === id ? { ...m, included: !m.included } : m))
    );
  };

  const downloadServerPack = async () => {
    const { zip, manifest } = analysisRef.current;
    if (!zip || !manifest || !analyzedMods) return;

    setIsDownloadingServer(true);
    setError(null);

    try {
      const includedPaths = new Set(
        analyzedMods.filter((m) => m.included).map((m) => m.path)
      );
      const serverFiles = manifest.files.filter((f) => includedPaths.has(f.path));

      const serverManifest = {
        ...manifest,
        name: manifest.name ? `${manifest.name} (Server)` : 'Server Pack',
        files: serverFiles,
      };

      const JSZip = (await import('jszip')).default;
      const outZip = new JSZip();
      outZip.file('modrinth.index.json', JSON.stringify(serverManifest, null, 2));

      // overrides/ is the base; server-overrides/ wins on matching paths;
      // client-overrides/ is intentionally dropped.
      const zipEntries = Object.values(zip.files);

      for (const entry of zipEntries) {
        if (entry.dir) continue;

        if (entry.name.startsWith('overrides/')) {
          outZip.file(entry.name, await entry.async('uint8array'));
        } else if (entry.name.startsWith('server-overrides/')) {
          const targetPath = entry.name.replace(/^server-overrides\//, 'overrides/');
          outZip.file(targetPath, await entry.async('uint8array'));
        }
      }

      const blob = await outZip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const baseName = serverFile.name.replace(/\.mrpack$/i, '');

      const link = document.createElement('a');
      link.href = url;
      link.download = `${baseName}-server.mrpack`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Failed to build server pack.');
      console.error(err);
    } finally {
      setIsDownloadingServer(false);
    }
  };

  const handleTabKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % TABS.length;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + TABS.length) % TABS.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = TABS.length - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      const nextId = TABS[nextIndex].id;
      setActiveTab(nextId);
      tabRefs.current[nextId]?.focus();
    }
  };

  const modCounts = analyzedMods
    ? {
      keep: analyzedMods.filter((m) => m.category === 'keep').length,
      exclude: analyzedMods.filter((m) => m.category === 'exclude').length,
      review: analyzedMods.filter((m) => m.category === 'review').length,
    }
    : null;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Modpack Toolkit</h1>
        <p className="app-subtitle">
          Generate changelogs and build server packs for Modrinth-based Minecraft modpacks.
        </p>
      </header>

      {error && (
        <div className="banner banner-error" role="alert">
          <strong>Error:</strong> {error}
        </div>
      )}

      <div className="tablist" role="tablist" aria-label="Toolkit sections">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(el) => (tabRefs.current[tab.id] = el)}
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            className={`tab-btn ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
            onKeyDown={(e) => handleTabKeyDown(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <main>
        <section
          id="panel-compare"
          role="tabpanel"
          aria-labelledby="tab-compare"
          hidden={activeTab !== 'compare'}
        >
          <h2 className="sr-only">Compare Packs</h2>

          <div className="two-col">
            <div className="input-section">
              <label htmlFor="old-json">Old Modpack JSON</label>
              <p className="hint">Paste a JSON array, or select a `.mrpack` file below.</p>

              <textarea
                id="old-json"
                className="json-input"
                aria-label="Old modpack JSON"
                value={oldJson}
                onChange={(e) => setOldJson(e.target.value)}
                placeholder='[{"name":"ModName","url":"...","version":"1.0.0"}]'
                disabled={!!oldFile}
              />

              <label htmlFor="old-file" className="file-label">
                Or select old <code>.mrpack</code>
              </label>
              <input id="old-file" type="file" accept=".mrpack" onChange={handleOldFileChange} />

              {oldFile && (
                <div className="selected-file">
                  Selected: {oldFile.name}
                  <button type="button" onClick={() => setOldFile(null)}>
                    Clear
                  </button>
                </div>
              )}
            </div>

            <div className="input-section">
              <label htmlFor="new-json">New Modpack JSON</label>
              <p className="hint">Paste a JSON array, or select a `.mrpack` file below.</p>

              <textarea
                id="new-json"
                className="json-input"
                aria-label="New modpack JSON"
                value={newJson}
                onChange={(e) => setNewJson(e.target.value)}
                placeholder='[{"name":"ModName","url":"...","version":"2.0.0"}]'
                disabled={!!newFile}
              />

              <label htmlFor="new-file" className="file-label">
                Or select new <code>.mrpack</code>
              </label>
              <input id="new-file" type="file" accept=".mrpack" onChange={handleNewFileChange} />

              {newFile && (
                <div className="selected-file">
                  Selected: {newFile.name}
                  <button type="button" onClick={() => setNewFile(null)}>
                    Clear
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="controls">
            <button onClick={generateChangelog} className="primary" disabled={isGenerating} aria-busy={isGenerating}>
              {isGenerating ? 'Generating…' : 'Generate Changelog'}
            </button>

            <button onClick={copyToClipboard} className="secondary" disabled={!markdownText}>
              {copied ? 'Copied' : 'Copy Markdown'}
            </button>
          </div>

          {changeSummary && (
            <div className="stat-row" role="status" aria-live="polite">
              <span className="stat-chip stat-added">+ {changeSummary.added} added</span>
              <span className="stat-chip stat-updated">~ {changeSummary.updated} updated</span>
              <span className="stat-chip stat-removed">− {changeSummary.removed} removed</span>
            </div>
          )}

          <div className="output">
            <label htmlFor="markdown-output">Markdown Output</label>

            <div className="two-col output-grid">
              <pre id="markdown-output" className="markdown-output" aria-label="Markdown output">
                {markdownText}
              </pre>

              <div
                className="markdown-preview"
                aria-label="Rendered markdown preview"
                dangerouslySetInnerHTML={{ __html: renderMarkdownToHTML(markdownText) }}
              />
            </div>
          </div>
        </section>

        <section
          id="panel-server"
          role="tabpanel"
          aria-labelledby="tab-server"
          hidden={activeTab !== 'server'}
        >
          <h2 className="sr-only">Build Server Pack</h2>

          <p className="hint">
            Upload a client <code>.mrpack</code> and analyze it first. Files are classified using
            both the pack's own metadata and each mod's Modrinth project data, since packs don't
            always mark client-only mods correctly. Anything ambiguous is left for you to decide
            below before downloading.
          </p>

          <div className="two-col server-layout">
            <div className="input-section">
              <label htmlFor="server-file" className="file-label">
                Select <code>.mrpack</code> file
              </label>
              <input
                id="server-file"
                type="file"
                accept=".mrpack"
                onChange={handleServerFileChange}
              />

              {serverFile && (
                <div className="selected-file">
                  Selected: {serverFile.name}
                  <button
                    type="button"
                    onClick={() => {
                      setServerFile(null);
                      setAnalyzedMods(null);
                      analysisRef.current = { zip: null, manifest: null };
                    }}
                  >
                    Clear
                  </button>
                </div>
              )}

              <div className="controls">
                <button
                  onClick={analyzeServerPack}
                  className="primary"
                  disabled={!serverFile || isAnalyzing}
                  aria-busy={isAnalyzing}
                >
                  {isAnalyzing ? 'Analyzing…' : 'Analyze Pack'}
                </button>

                <button
                  onClick={downloadServerPack}
                  className="secondary"
                  disabled={!analyzedMods || isDownloadingServer}
                  aria-busy={isDownloadingServer}
                >
                  {isDownloadingServer ? 'Building…' : 'Download Server Pack'}
                </button>
              </div>

              {modCounts && (
                <div className="stat-row" role="status" aria-live="polite">
                  <span className="stat-chip stat-added">✓ {modCounts.keep} kept</span>
                  <span className="stat-chip stat-removed">✕ {modCounts.exclude} excluded</span>
                  <span className="stat-chip stat-updated">? {modCounts.review} to review</span>
                </div>
              )}
            </div>

            <div className="input-section">
              {analyzedMods ? (
                <div className="mod-review" aria-label="Mod inclusion review">
                  {['review', 'exclude', 'keep'].map((cat) => {
                    const items = analyzedMods.filter((m) => m.category === cat);
                    if (items.length === 0) return null;

                    return (
                      <fieldset key={cat} className={`mod-group mod-group-${cat}`}>
                        <legend>
                          {CATEGORY_LABELS[cat]} ({items.length})
                        </legend>

                        <ul className="mod-list">
                          {items.map((mod) => (
                            <li key={mod.id} className="mod-row">
                              <label htmlFor={`mod-${mod.id}`}>
                                <input
                                  id={`mod-${mod.id}`}
                                  type="checkbox"
                                  checked={mod.included}
                                  onChange={() => toggleModIncluded(mod.id)}
                                />
                                <span className="mod-name">{mod.name}</span>
                                <span className="mod-reason">{mod.reason}</span>
                              </label>

                              {mod.url ? (
                                <a
                                  className="mod-link"
                                  href={mod.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label={`Open ${mod.name} page (opens in a new tab)`}
                                >
                                  View mod ↗
                                </a>
                              ) : (
                                <span className="mod-link mod-link-disabled">No link found</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </fieldset>
                    );
                  })}
                </div>
              ) : (
                <p className="hint">Analyze a pack to review which mods will be included.</p>
              )}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;