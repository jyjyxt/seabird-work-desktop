import { Marked, Renderer, type Tokens } from 'marked';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function mediaFileUrl(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const encoded = normalized.split('/').map((part, index) => index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encoded}`;
}

export function articleMediaLink(kind: 'image' | 'video', value: string): string | null {
  const input = value.trim();
  if (!input || /[\u0000-\u001f\u007f]/.test(input)) return null;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return kind === 'image' ? `![](<${url.href}>)` : `<video controls src="${url.href}"></video>`;
  } catch {
    return null;
  }
}

function safeUrl(url: string, link = false): string {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'file:', ...(link ? ['mailto:'] : [])].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    // Preserve normal relative links while rejecting protocol-relative URLs and control characters.
    return /^(?!\/\/)(?![^/]*:)[^\\\u0000-\u001f]+$/.test(url) ? url : '';
  }
}

export function articleMarkdown(title: string, body: string): string {
  const heading = title.trim().replace(/\s*\n\s*/g, ' ').replace(/[\\`*_{}\[\]<>#!]/g, '\\$&');
  return [heading ? `# ${heading}` : '', body.replace(/^\n+|\n+$/g, '')].filter(Boolean).join('\n\n');
}

// Local files are converted to asset URLs only for the in-app preview.
export function articleHtml(title: string, body: string, previewUrl?: (fileUrl: string) => string): string {
  const urlFor = (url: string, link = false) => {
    const safe = safeUrl(url, link);
    return safe && previewUrl && safe.startsWith('file:') && !link ? previewUrl(safe) : safe;
  };
  const renderer = new Renderer();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.image = ({ href, text, title }: Tokens.Image) => {
    const src = urlFor(href);
    return src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${title ? ` title="${escapeHtml(title)}"` : ''}>` : escapeHtml(text);
  };
  renderer.link = function ({ href, title, tokens }: Tokens.Link) {
    const text = this.parser.parseInline(tokens);
    const target = urlFor(href, true);
    return target ? `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</a>` : text;
  };
  const markdown = new Marked({ renderer, breaks: true });
  markdown.use({ extensions: [{
    name: 'articleVideo', level: 'inline',
    start(src) { return src.indexOf('<video '); },
    tokenizer(src) {
      const match = /^<video controls src="([^"<>]+)"><\/video>/.exec(src);
      if (match) return { type: 'articleVideo', raw: match[0], src: match[1] };
    },
    renderer(token) {
      const src = urlFor(String(token.src));
      return src ? `<video controls src="${escapeHtml(src)}"></video>` : '';
    },
  }] });
  const heading = title.trim() ? `<h1>${escapeHtml(title.trim())}</h1>\n` : '';
  return heading + markdown.parse(body, { async: false });
}
