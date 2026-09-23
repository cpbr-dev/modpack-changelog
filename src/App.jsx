import { useState } from 'react';
import './App.css';

function App() {
  const [oldJson, setOldJson] = useState('');
  const [newJson, setNewJson] = useState('');
  const [oldFile, setOldFile] = useState(null);
  const [newFile, setNewFile] = useState(null);
  const [markdownText, setMarkdownText] = useState('');
  const [copied, setCopied] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  // Normalize names for comparison while keeping the original name for display.
  // Handles leading/trailing whitespace and multiple spaces inside names.
  const normalizeName = (name) =>
    String(name ?? '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();

  // very small, safe markdown -> HTML converter for minimal preview
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

    // simple bold **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    return html;
  };

  const generateMarkdown = (data) => {
    const sections = [];

    const fmtLink = (mod) =>
      mod.url
        ? `[${mod.name}](${mod.url})`
        : `**${mod.name}**`;

    const fmtVer = (v) => (v ? '`' + v + '`' : '');

    const sortByName = (arr) =>
      arr
        .slice()
        .sort((a, b) =>
          String(a.name ?? '').localeCompare(String(b.name ?? ''))
        );

    if (data.added && data.added.length > 0) {
      const items = sortByName(data.added);

      sections.push({
        title: `Added (${items.length})`,
        lines: items.map(
          (m) => `- ${fmtLink(m)} ${fmtVer(m.version)}`
        ),
      });
    }

    if (data.updated && data.updated.length > 0) {
      const items = sortByName(data.updated);

      sections.push({
        title: `Updated (${items.length})`,
        lines: items.map(
          (m) =>
            `- ${fmtLink(m)}: ${fmtVer(m.oldVersion)} → ${fmtVer(m.version)}`
        ),
      });
    }

    if (data.removed && data.removed.length > 0) {
      const items = sortByName(data.removed);

      sections.push({
        title: `Removed (${items.length})`,
        lines: items.map(
          (m) => `- ${fmtLink(m)} ${fmtVer(m.version)}`
        ),
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
   *
   * modrinth.index.json's `files` array does NOT contain a human-readable
   * mod name or version number — only a path and content hashes. The
   * previous implementation fell back to the raw sha1/sha512 hash as the
   * "version", which made changelogs unreadable (hashes instead of
   * version numbers) and used ugly filename-derived names.
   *
   * The fix: resolve each file's sha1 hash against Modrinth's public API
   * to get the real project title and version number.
   *
   * Docs: https://docs.modrinth.com/api/operations/versionsfromhashes/
   *       https://docs.modrinth.com/api/operations/getprojects/
   */

  // Modrinth's bulk endpoints comfortably handle large batches, but we
  // chunk defensively so a huge modpack (500+ mods) can't produce an
  // oversized request.
  const chunk = (arr, size) => {
    const out = [];
    for (let i = 0; i < arr.length; i += size) {
      out.push(arr.slice(i, i + size));
    }
    return out;
  };

  const fetchVersionsByHashes = async (hashes) => {
    if (hashes.length === 0) return {};

    const chunks = chunk(hashes, 200);
    const results = {};

    for (const batch of chunks) {
      const res = await fetch('https://api.modrinth.com/v2/version_files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashes: batch, algorithm: 'sha1' }),
      });

      if (!res.ok) {
        throw new Error(`Modrinth API error (${res.status})`);
      }

      Object.assign(results, await res.json());
    }

    return results; // { [sha1Hash]: versionObject }
  };

  const fetchProjectsByIds = async (ids) => {
    if (ids.length === 0) return [];

    const chunks = chunk(ids, 200);
    const results = [];

    for (const batch of chunks) {
      const res = await fetch(
        `https://api.modrinth.com/v2/projects?ids=${encodeURIComponent(
          JSON.stringify(batch)
        )}`
      );

      if (!res.ok) {
        throw new Error(`Modrinth API error (${res.status})`);
      }

      results.push(...(await res.json()));
    }

    return results; // [{ id, slug, title, ... }]
  };

  /*
   * Modrinth .mrpack files are ZIP files.
   *
   * We read modrinth.index.json, then resolve each file's sha1 hash
   * against the Modrinth API to get its real mod name and version
   * number. If the API is unreachable, or a specific file/hash isn't
   * recognized, we fall back to a filename/hash-derived entry so the
   * app still works offline.
   */
  const parseMrpack = async (file) => {
    if (!file) {
      throw new Error('No mrpack file selected.');
    }

    // JSZip is loaded dynamically so the app can still start normally.
    const JSZip = (await import('jszip')).default;

    const zip = await JSZip.loadAsync(file);

    const manifestFile = zip.file('modrinth.index.json');

    if (!manifestFile) {
      throw new Error(
        `${file.name} does not contain modrinth.index.json`
      );
    }

    const manifestText = await manifestFile.async('text');
    const manifest = JSON.parse(manifestText);

    if (!Array.isArray(manifest.files)) {
      throw new Error(
        `${file.name} contains an invalid Modrinth index`
      );
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

      // Last-resort "version": still better than nothing, but clearly
      // not a real version number, so keep it hash-based only as a
      // final fallback.
      const version = hashes.sha512 || hashes.sha1 || '';

      return { name, url, version };
    };

    const sha1ToEntry = new Map();
    entries.forEach((entry) => {
      const sha1 = entry.hashes?.sha1;
      if (sha1) {
        sha1ToEntry.set(sha1, entry);
      }
    });

    const hashes = Array.from(sha1ToEntry.keys());

    let versionByHash = {};
    try {
      versionByHash = await fetchVersionsByHashes(hashes);
    } catch (err) {
      console.error(
        'Modrinth version lookup failed, falling back to filenames/hashes:',
        err
      );
      return entries.map(fallbackFor);
    }

    const projectIds = Array.from(
      new Set(
        Object.values(versionByHash)
          .map((v) => v.project_id)
          .filter(Boolean)
      )
    );

    let projects = [];
    try {
      projects = await fetchProjectsByIds(projectIds);
    } catch (err) {
      console.error(
        'Modrinth project lookup failed, using version names/IDs only:',
        err
      );
    }

    const projectById = new Map(projects.map((p) => [p.id, p]));

    return entries.map((entry) => {
      const sha1 = entry.hashes?.sha1;
      const version = sha1 ? versionByHash[sha1] : null;

      if (!version) {
        return fallbackFor(entry);
      }

      const project = projectById.get(version.project_id);

      const url = project?.slug
        ? `https://modrinth.com/mod/${project.slug}`
        : Array.isArray(entry.downloads) && entry.downloads.length > 0
          ? entry.downloads[0]
          : '';

      return {
        name: project?.title || fallbackFor(entry).name,
        url,
        // The actual, human-readable version number (e.g. "1.2.3"),
        // not a hash.
        version: version.version_number || fallbackFor(entry).version,
      };
    });
  };

  const readInput = async (jsonText, file) => {
    if (file) {
      return await parseMrpack(file);
    }

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

    try {
      const [oldMods, newMods] = await Promise.all([
        readInput(oldJson, oldFile),
        readInput(newJson, newFile),
      ]);

      /*
       * Use normalized names as map keys.
       *
       * This fixes names such as:
       *
       * "Example Mod"
       * "Example  Mod"
       * " example mod "
       *
       * being treated as different mods.
       */
      const oldModsMap = new Map();

      oldMods.forEach((mod) => {
        const key = normalizeName(mod.name);

        if (key) {
          oldModsMap.set(key, mod);
        }
      });

      const newModsMap = new Map();

      newMods.forEach((mod) => {
        const key = normalizeName(mod.name);

        if (key) {
          newModsMap.set(key, mod);
        }
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
          updated.push({
            ...newMod,
            oldVersion: oldMod.version,
          });
        }
      });

      oldMods.forEach((oldMod) => {
        const key = normalizeName(oldMod.name);

        if (!newModsMap.has(key)) {
          removed.push(oldMod);
        }
      });

      const changelogData = {
        added,
        removed,
        updated,
      };

      setMarkdownText(generateMarkdown(changelogData));
    } catch (error) {
      alert(
        error.message ||
          'Invalid input. Please check your JSON or .mrpack file.'
      );

      console.error(error);
    } finally {
      setIsGenerating(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(markdownText);

      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (err) {
      alert('Failed to copy to clipboard');
      console.error(err);
    }
  };

  const handleOldFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setOldFile(file);
  };

  const handleNewFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    setNewFile(file);
  };

  return (
    <div className="app">
      <h1>Modpack Changelog Generator</h1>

      <div className="container">
        <div className="input-section">
          <label htmlFor="old-json">
            Old Modpack JSON
          </label>

          <textarea
            id="old-json"
            className="json-input"
            aria-label="Old modpack JSON"
            value={oldJson}
            onChange={(e) => setOldJson(e.target.value)}
            placeholder='[{"name":"ModName","url":"...","version":"1.0.0"}]'
            disabled={!!oldFile}
          />

          <label
            htmlFor="old-file"
            className="file-label"
          >
            Or select old `.mrpack`
          </label>

          <input
            id="old-file"
            type="file"
            accept=".mrpack"
            onChange={handleOldFileChange}
          />

          {oldFile && (
            <div className="selected-file">
              Selected: {oldFile.name}
              <button
                type="button"
                onClick={() => setOldFile(null)}
              >
                Clear
              </button>
            </div>
          )}
        </div>

        <div className="input-section">
          <label htmlFor="new-json">
            New Modpack JSON
          </label>

          <textarea
            id="new-json"
            className="json-input"
            aria-label="New modpack JSON"
            value={newJson}
            onChange={(e) => setNewJson(e.target.value)}
            placeholder='[{"name":"ModName","url":"...","version":"2.0.0"}]'
            disabled={!!newFile}
          />

          <label
            htmlFor="new-file"
            className="file-label"
          >
            Or select new `.mrpack`
          </label>

          <input
            id="new-file"
            type="file"
            accept=".mrpack"
            onChange={handleNewFileChange}
          />

          {newFile && (
            <div className="selected-file">
              Selected: {newFile.name}
              <button
                type="button"
                onClick={() => setNewFile(null)}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="controls">
        <button
          onClick={generateChangelog}
          className="primary"
          disabled={isGenerating}
        >
          {isGenerating ? 'Generating…' : 'Generate Changelog'}
        </button>

        <button
          onClick={copyToClipboard}
          className="copy-btn"
          disabled={!markdownText}
        >
          {copied ? 'Copied' : 'Copy Markdown'}
        </button>
      </div>

      <div className="output">
        <label htmlFor="markdown-output">
          Markdown Output
        </label>

        <div className="output-grid">
          <pre
            id="markdown-output"
            className="markdown-output"
            aria-label="Markdown output"
          >
            {markdownText}
          </pre>

          <div
            className="markdown-preview"
            aria-label="Rendered markdown preview"
            dangerouslySetInnerHTML={{
              __html: renderMarkdownToHTML(markdownText),
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default App;