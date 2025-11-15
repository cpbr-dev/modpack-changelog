import { useState } from 'react';
import './App.css';

function App() {
  const [oldJson, setOldJson] = useState('');
  const [newJson, setNewJson] = useState('');
  const [markdownText, setMarkdownText] = useState('');
  const [copied, setCopied] = useState(false);

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
      const line = raw.trimRight();
      if (/^#{1,6}\s+/.test(line)) {
        if (inList) { html += '</ul>'; inList = false; }
        const level = line.match(/^#{1,6}/)[0].length;
        const text = line.replace(/^#{1,6}\s+/, '');
        html += `<h${level}>${text}</h${level}>`;
      } else if (/^-\s+/.test(line)) {
        if (!inList) { html += '<ul>'; inList = true; }
        const text = line.replace(/^-\s+/, '');
        html += `<li>${text}</li>`;
      } else if (line === '') {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<p></p>';
      } else {
        html += `<p>${line}</p>`;
      }
    });
    if (inList) html += '</ul>';
    // simple bold **text**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    return html;
  };

  const generateMarkdown = (data) => {
    const sections = [];

    const now = new Date();
    const timestamp = now.toISOString();

  const fmtLink = (mod) => mod.url ? `[${mod.name}](${mod.url})` : `**${mod.name}**`;
  const fmtVer = (v) => v ? '`' + v + '`' : '';

    // helper to sort by name
    const sortByName = (arr) => arr.slice().sort((a, b) => a.name.localeCompare(b.name));

    if (data.added && data.added.length > 0) {
      const items = sortByName(data.added);
      sections.push({ title: `Added (${items.length})`, lines: items.map(m => `- ${fmtLink(m)} ${fmtVer(m.version)}`) });
    }

    if (data.updated && data.updated.length > 0) {
      const items = sortByName(data.updated);
      sections.push({ title: `Updated (${items.length})`, lines: items.map(m => `- ${fmtLink(m)}: ${fmtVer(m.oldVersion)} → ${fmtVer(m.version)}`) });
    }

    if (data.removed && data.removed.length > 0) {
      const items = sortByName(data.removed);
      sections.push({ title: `Removed (${items.length})`, lines: items.map(m => `- ${fmtLink(m)} ${fmtVer(m.version)}`) });
    }

    if (sections.length === 0) {
      return `No changes detected.\n`;
    }

    let markdown = ``;
    sections.forEach(sec => {
      markdown += `## ${sec.title}\n\n`;
      sec.lines.forEach(l => { markdown += `${l}\n`; });
      markdown += '\n';
    });

    return markdown;
  };

  const generateChangelog = () => {
    try {
      const oldMods = JSON.parse(oldJson);
      const newMods = JSON.parse(newJson);

      const oldModsMap = new Map(oldMods.map(mod => [mod.name, mod]));
      const newModsMap = new Map(newMods.map(mod => [mod.name, mod]));

      const added = [];
      const removed = [];
      const updated = [];

      newMods.forEach(newMod => {
        const oldMod = oldModsMap.get(newMod.name);
        if (!oldMod) {
          added.push(newMod);
        } else if (oldMod.version !== newMod.version) {
          updated.push({ ...newMod, oldVersion: oldMod.version });
        }
      });

      oldMods.forEach(oldMod => {
        if (!newModsMap.has(oldMod.name)) {
          removed.push(oldMod);
        }
      });

      const changelogData = { added, removed, updated };
      setMarkdownText(generateMarkdown(changelogData));
    } catch (error) {
      alert('Invalid JSON format. Please check your input.');
      console.error(error);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(markdownText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      alert('Failed to copy to clipboard');
      console.error(err);
    }
  };

  return (
    <div className="app">
      <h1>Modpack Changelog Generator</h1>

      <div className="container">
        <div className="input-section">
          <label htmlFor="old-json">Old Modpack JSON</label>
          <textarea
            id="old-json"
            className="json-input"
            aria-label="Old modpack JSON"
            value={oldJson}
            onChange={(e) => setOldJson(e.target.value)}
            placeholder='[{"name":"ModName","url":"...","version":"1.0.0"}]'
          />
        </div>

        <div className="input-section">
          <label htmlFor="new-json">New Modpack JSON</label>
          <textarea
            id="new-json"
            className="json-input"
            aria-label="New modpack JSON"
            value={newJson}
            onChange={(e) => setNewJson(e.target.value)}
            placeholder='[{"name":"ModName","url":"...","version":"2.0.0"}]'
          />
        </div>
      </div>

      <div className="controls">
        <button onClick={generateChangelog} className="primary">Generate Changelog</button>
        <button onClick={copyToClipboard} className="copy-btn">{copied ? 'Copied' : 'Copy Markdown'}</button>
      </div>

      <div className="output">
        <label htmlFor="markdown-output">Markdown Output</label>
        <div className="output-grid">
          <pre id="markdown-output" className="markdown-output" aria-label="Markdown output">{markdownText}</pre>
          <div className="markdown-preview" aria-label="Rendered markdown preview" dangerouslySetInnerHTML={{ __html: renderMarkdownToHTML(markdownText) }} />
        </div>
      </div>
    </div>
  );
}

export default App;
