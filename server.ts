import express, { type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal',
]);

function isPrivateOrBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }

  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    return true;
  }

  return false;
}

function normalizeTargetUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (isPrivateOrBlockedHost(parsed.hostname)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function toProxyUrl(targetUrl: string): string {
  return `/api/proxy?url=${encodeURIComponent(targetUrl)}`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function resolveMaybeUrl(rawRef: string, baseUrl: string): string | null {
  const ref = decodeHtmlEntities(rawRef).trim();
  if (
    !ref ||
    ref.startsWith('#') ||
    ref.startsWith('/api/proxy?') ||
    /^(javascript|mailto|tel|sms|data|blob|about):/i.test(ref)
  ) {
    return null;
  }
  try {
    const resolved = new URL(ref, baseUrl);
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

function rewriteCss(css: string, baseUrl: string): string {
  let out = css.replace(
    /@import\s+(?:url\(\s*(['"]?)([^)'"]+)\1\s*\)|(['"])([^'"]+)\3)/gi,
    (match, _q1, urlA, _q2, urlB) => {
      const raw = (urlA ?? urlB ?? '').trim();
      const resolved = resolveMaybeUrl(raw, baseUrl);
      if (!resolved) return match;
      return `@import url("${toProxyUrl(resolved)}")`;
    }
  );

  out = out.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (match, _quote, rawUrl) => {
    const resolved = resolveMaybeUrl(rawUrl, baseUrl);
    if (!resolved) return match;
    return `url("${toProxyUrl(resolved)}")`;
  });

  return out;
}

function rewriteSrcset(value: string, baseUrl: string): string {
  return decodeHtmlEntities(value)
    .split(',')
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (!parts[0]) return entry;
      const resolved = resolveMaybeUrl(parts[0], baseUrl);
      if (!resolved) return entry;
      parts[0] = toProxyUrl(resolved);
      return parts.join(' ');
    })
    .join(', ');
}

function rewriteTagAttributes(attrs: string, baseUrl: string): string {
  let updated = attrs
    .replace(/\s+integrity\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+nonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+crossorigin(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');

  updated = updated.replace(
    /\b(href|src|action|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
    (match, attr, dq, sq, bare) => {
      const val = dq ?? sq ?? bare ?? '';
      const resolved = resolveMaybeUrl(val, baseUrl);
      if (!resolved) return match;
      return `${attr}="${toProxyUrl(resolved)}"`;
    }
  );

  updated = updated.replace(/\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (match, dq, sq) => {
    const val = dq ?? sq ?? '';
    if (!val.trim()) return match;
    return `srcset="${rewriteSrcset(val, baseUrl)}"`;
  });

  updated = updated.replace(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (match, dq, sq) => {
    const val = decodeHtmlEntities(dq ?? sq ?? '');
    if (!/url\(/i.test(val)) return match;
    return `style="${rewriteCss(val, baseUrl).replace(/"/g, '&quot;')}"`;
  });

  return updated;
}

interface JsToken {
  kind: 'id' | 'num' | 'str' | 'tmpl' | 'regex' | 'punc' | 'op';
  value: string;
  start: number;
  end: number;
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'throw',
  'case',
  'delete',
  'void',
  'typeof',
  'yield',
  'await',
  'in',
  'instanceof',
  'new',
  'of',
  'do',
  'else',
]);

const CONTROL_PAREN_KEYWORDS = new Set(['if', 'for', 'while', 'with']);
const VIRTUAL_PROPS = new Set(['location', 'top', 'parent', 'frameElement']);
const GLOBAL_WIN_IDS = new Set(['window', 'self', 'globalThis']);
const DECL_KEYWORDS = new Set(['var', 'let', 'const', 'function', 'class']);

function isIdentStart(ch: number): boolean {
  return (
    (ch >= 65 && ch <= 90) ||
    (ch >= 97 && ch <= 122) ||
    ch === 95 ||
    ch === 36 ||
    ch >= 128
  );
}

function isIdentPart(ch: number): boolean {
  return isIdentStart(ch) || (ch >= 48 && ch <= 57);
}

function isWhitespace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12 || ch === 11 || ch === 160;
}

function tokenizeJs(code: string): JsToken[] {
  const tokens: JsToken[] = [];
  const len = code.length;
  let i = 0;
  let canStartRegex = true;
  const parenControlStack: boolean[] = [];
  const templateBraceStack: number[] = [];
  let braceDepth = 0;

  function scanTemplateChunk(startIdx: number): void {
    let j = startIdx;
    while (j < len) {
      const c = code.charCodeAt(j);
      if (c === 92) {
        j += 2;
        continue;
      }
      if (c === 96) {
        j += 1;
        tokens.push({ kind: 'tmpl', value: '`', start: startIdx - 1, end: j });
        i = j;
        canStartRegex = false;
        return;
      }
      if (c === 36 && code.charCodeAt(j + 1) === 123) {
        braceDepth += 1;
        templateBraceStack.push(braceDepth);
        tokens.push({ kind: 'punc', value: '${', start: j, end: j + 2 });
        i = j + 2;
        canStartRegex = true;
        return;
      }
      j += 1;
    }
    i = len;
  }

  while (i < len) {
    const ch = code.charCodeAt(i);

    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }

    // Comments
    if (ch === 47) {
      const next = code.charCodeAt(i + 1);
      if (next === 47) {
        i += 2;
        while (i < len && code.charCodeAt(i) !== 10 && code.charCodeAt(i) !== 13) i += 1;
        continue;
      }
      if (next === 42) {
        i += 2;
        while (i < len && !(code.charCodeAt(i) === 42 && code.charCodeAt(i + 1) === 47)) i += 1;
        i += 2;
        continue;
      }
      if (canStartRegex) {
        const start = i;
        i += 1;
        let inClass = false;
        while (i < len) {
          const rc = code.charCodeAt(i);
          if (rc === 92) {
            i += 2;
            continue;
          }
          if (rc === 91) {
            inClass = true;
            i += 1;
            continue;
          }
          if (rc === 93 && inClass) {
            inClass = false;
            i += 1;
            continue;
          }
          if (rc === 47 && !inClass) {
            i += 1;
            break;
          }
          if (rc === 10 || rc === 13) {
            break;
          }
          i += 1;
        }
        while (i < len && isIdentStart(code.charCodeAt(i))) i += 1;
        tokens.push({ kind: 'regex', value: '/', start, end: i });
        canStartRegex = false;
        continue;
      }
    }

    // Strings ' or "
    if (ch === 39 || ch === 34) {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < len) {
        const sc = code.charCodeAt(i);
        if (sc === 92) {
          i += 2;
          continue;
        }
        if (sc === quote) {
          i += 1;
          break;
        }
        if (sc === 10 || sc === 13) {
          break;
        }
        i += 1;
      }
      tokens.push({ kind: 'str', value: code.slice(start, i), start, end: i });
      canStartRegex = false;
      continue;
    }

    // Template literals `
    if (ch === 96) {
      i += 1;
      scanTemplateChunk(i);
      continue;
    }

    // Identifiers & keywords
    if (isIdentStart(ch)) {
      const start = i;
      i += 1;
      while (i < len && isIdentPart(code.charCodeAt(i))) i += 1;
      const value = code.slice(start, i);
      const prev = tokens[tokens.length - 1];
      const afterDot = prev && prev.kind === 'punc' && (prev.value === '.' || prev.value === '?.');
      tokens.push({ kind: 'id', value, start, end: i });
      canStartRegex = !afterDot && REGEX_PRECEDING_KEYWORDS.has(value);
      continue;
    }

    // Numbers
    if ((ch >= 48 && ch <= 57) || (ch === 46 && code.charCodeAt(i + 1) >= 48 && code.charCodeAt(i + 1) <= 57)) {
      const start = i;
      i += 1;
      while (i < len) {
        const nc = code.charCodeAt(i);
        if (isIdentPart(nc) || nc === 46) {
          i += 1;
          continue;
        }
        if ((nc === 43 || nc === 45) && (code.charCodeAt(i - 1) === 101 || code.charCodeAt(i - 1) === 69)) {
          i += 1;
          continue;
        }
        break;
      }
      tokens.push({ kind: 'num', value: code.slice(start, i), start, end: i });
      canStartRegex = false;
      continue;
    }

    // Optional chaining ?. (only when not followed by digit like ?.5)
    if (ch === 63 && code.charCodeAt(i + 1) === 46) {
      const d = code.charCodeAt(i + 2);
      if (!(d >= 48 && d <= 57)) {
        tokens.push({ kind: 'punc', value: '?.', start: i, end: i + 2 });
        i += 2;
        canStartRegex = false;
        continue;
      }
    }

    // Punctuation
    if (
      ch === 46 || // .
      ch === 40 || // (
      ch === 41 || // )
      ch === 91 || // [
      ch === 93 || // ]
      ch === 123 || // {
      ch === 125 || // }
      ch === 44 || // ,
      ch === 59 || // ;
      ch === 58 || // :
      ch === 63 // ?
    ) {
      const chStr = code[i];
      if (ch === 40) {
        const prev = tokens[tokens.length - 1];
        const prevPrev = tokens[tokens.length - 2];
        const afterDot = prevPrev && prevPrev.kind === 'punc' && (prevPrev.value === '.' || prevPrev.value === '?.');
        const isCtrl = Boolean(prev && prev.kind === 'id' && !afterDot && CONTROL_PAREN_KEYWORDS.has(prev.value));
        parenControlStack.push(isCtrl);
        tokens.push({ kind: 'punc', value: chStr, start: i, end: i + 1 });
        i += 1;
        canStartRegex = true;
      } else if (ch === 41) {
        const wasCtrl = parenControlStack.pop() || false;
        tokens.push({ kind: 'punc', value: chStr, start: i, end: i + 1 });
        i += 1;
        canStartRegex = wasCtrl;
      } else if (ch === 123) {
        braceDepth += 1;
        tokens.push({ kind: 'punc', value: chStr, start: i, end: i + 1 });
        i += 1;
        canStartRegex = true;
      } else if (ch === 125) {
        tokens.push({ kind: 'punc', value: chStr, start: i, end: i + 1 });
        i += 1;
        if (templateBraceStack.length > 0 && braceDepth === templateBraceStack[templateBraceStack.length - 1]) {
          templateBraceStack.pop();
          braceDepth -= 1;
          scanTemplateChunk(i);
          continue;
        }
        braceDepth = Math.max(0, braceDepth - 1);
        canStartRegex = true;
      } else if (ch === 46) {
        if (code.charCodeAt(i + 1) === 46 && code.charCodeAt(i + 2) === 46) {
          tokens.push({ kind: 'op', value: '...', start: i, end: i + 3 });
          i += 3;
          canStartRegex = true;
        } else {
          tokens.push({ kind: 'punc', value: '.', start: i, end: i + 1 });
          i += 1;
          canStartRegex = false;
        }
      } else if (ch === 93) {
        tokens.push({ kind: 'punc', value: chStr, start: i, end: i + 1 });
        i += 1;
        canStartRegex = false;
      } else if (ch === 63 && code.charCodeAt(i + 1) === 63) {
        if (code.charCodeAt(i + 2) === 61) {
          tokens.push({ kind: 'op', value: '??=', start: i, end: i + 3 });
          i += 3;
        } else {
          tokens.push({ kind: 'op', value: '??', start: i, end: i + 2 });
          i += 2;
        }
        canStartRegex = true;
      } else {
        tokens.push({ kind: 'punc', value: chStr, start: i, end: i + 1 });
        i += 1;
        canStartRegex = true;
      }
      continue;
    }

    // Multi-char operators
    const start = i;
    const s2 = code.slice(i, i + 2);
    const s3 = code.slice(i, i + 3);
    const s4 = code.slice(i, i + 4);
    let op = code[i];
    if (s4 === '>>>=') op = s4;
    else if (s3 === '===' || s3 === '!==' || s3 === '>>>' || s3 === '**=' || s3 === '<<=' || s3 === '>>=' || s3 === '&&=' || s3 === '||=') {
      op = s3;
    } else if (
      s2 === '==' ||
      s2 === '!=' ||
      s2 === '<=' ||
      s2 === '>=' ||
      s2 === '=>' ||
      s2 === '++' ||
      s2 === '--' ||
      s2 === '&&' ||
      s2 === '||' ||
      s2 === '+=' ||
      s2 === '-=' ||
      s2 === '*=' ||
      s2 === '/=' ||
      s2 === '%=' ||
      s2 === '&=' ||
      s2 === '|=' ||
      s2 === '^=' ||
      s2 === '**' ||
      s2 === '<<' ||
      s2 === '>>'
    ) {
      op = s2;
    }
    i += op.length;
    tokens.push({ kind: 'op', value: op, start, end: i });
    canStartRegex = op !== '++' && op !== '--';
  }

  return tokens;
}

function isDotToken(tok: JsToken | undefined): boolean {
  return Boolean(tok && tok.kind === 'punc' && (tok.value === '.' || tok.value === '?.'));
}

function isAssignOrIncToken(tok: JsToken | undefined): boolean {
  if (!tok || tok.kind !== 'op') return false;
  return (
    tok.value === '=' ||
    tok.value === '+=' ||
    tok.value === '-=' ||
    tok.value === '*=' ||
    tok.value === '/=' ||
    tok.value === '%=' ||
    tok.value === '&&=' ||
    tok.value === '||=' ||
    tok.value === '??=' ||
    tok.value === '++' ||
    tok.value === '--'
  );
}

function rewriteJavaScript(code: string, baseUrl?: string): string {
  if (!code || code.length > 8_000_000) return code;
  const hasModuleKeywords =
    Boolean(baseUrl) && (code.includes('import') || code.includes('export'));
  if (
    !code.includes('location') &&
    !code.includes('top') &&
    !code.includes('parent') &&
    !code.includes('frameElement') &&
    !hasModuleKeywords
  ) {
    return code;
  }

  let tokens: JsToken[];
  try {
    tokens = tokenizeJs(code);
  } catch {
    return code;
  }

  const edits: Array<{ start: number; end: number; text: string }> = [];
  let lastEditEnd = 0;

  const propMap: Record<string, string> = {
    location: '__yamalLocation',
    top: '__yamalTop',
    parent: '__yamalParent',
    frameElement: '__yamalFrameElement',
  };

  const helperMap: Record<string, string> = {
    location: '__yLoc',
    top: '__yTop',
    parent: '__yParent',
    frameElement: '__yFrame',
  };

  const rewriteModuleSpecifier = (strTok: JsToken | undefined): void => {
    if (!baseUrl || !strTok || strTok.kind !== 'str' || strTok.start < lastEditEnd) return;
    const rawLit = strTok.value;
    if (rawLit.length < 3) return;
    const quote = rawLit[0];
    const spec = rawLit.slice(1, -1);
    if (
      !spec.startsWith('./') &&
      !spec.startsWith('../') &&
      !spec.startsWith('/') &&
      !/^https?:\/\//i.test(spec)
    ) {
      return;
    }
    const resolved = resolveMaybeUrl(spec, baseUrl);
    if (!resolved) return;
    edits.push({
      start: strTok.start,
      end: strTok.end,
      text: `${quote}${toProxyUrl(resolved)}${quote}`,
    });
    lastEditEnd = strTok.end;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];

    // Rewrite relative/http ES module specifiers (static import/export ... from '...' & dynamic import('...'))
    if (baseUrl && tok.kind === 'id' && (tok.value === 'import' || tok.value === 'export') && tok.start >= lastEditEnd) {
      const prev = tokens[i - 1];
      if (!isDotToken(prev)) {
        const next = tokens[i + 1];
        if (tok.value === 'import' && next && next.kind === 'str') {
          rewriteModuleSpecifier(next);
          i += 1;
          continue;
        }
        if (
          tok.value === 'import' &&
          next &&
          next.kind === 'punc' &&
          next.value === '(' &&
          tokens[i + 2] &&
          tokens[i + 2].kind === 'str' &&
          tokens[i + 3] &&
          tokens[i + 3].kind === 'punc' &&
          tokens[i + 3].value === ')'
        ) {
          rewriteModuleSpecifier(tokens[i + 2]);
          i += 3;
          continue;
        }
        // Scan forward within same statement for `from '...'`
        for (let k = i + 1; k < tokens.length && k < i + 64; k += 1) {
          const kt = tokens[k];
          if (kt.kind === 'punc' && (kt.value === ';' || kt.value === '{')) {
            // Allow `{ a, b } from '...'`
            if (kt.value === ';') break;
          }
          if (kt.kind === 'id' && kt.value === 'from' && tokens[k + 1] && tokens[k + 1].kind === 'str') {
            rewriteModuleSpecifier(tokens[k + 1]);
            i = k + 1;
            break;
          }
        }
      }
    }

    // Direct global prefixes: window|self|globalThis|document . (location|top|parent|frameElement)
    if (
      tok.kind === 'id' &&
      (GLOBAL_WIN_IDS.has(tok.value) || tok.value === 'document') &&
      tok.start >= lastEditEnd
    ) {
      const prev = tokens[i - 1];
      const precededByDot = isDotToken(prev);
      const precededByDecl = Boolean(prev && prev.kind === 'id' && DECL_KEYWORDS.has(prev.value));
      const dotTok = tokens[i + 1];
      const propTok = tokens[i + 2];

      if (!precededByDot && !precededByDecl && isDotToken(dotTok) && propTok && propTok.kind === 'id') {
        if (tok.value === 'document' && propTok.value === 'location') {
          edits.push({ start: propTok.start, end: propTok.end, text: '__yamalLocation' });
          lastEditEnd = propTok.end;
          i += 2;
          continue;
        }

        if (tok.value !== 'document' && VIRTUAL_PROPS.has(propTok.value)) {
          const nextDot = tokens[i + 3];
          const nextProp = tokens[i + 4];
          if (
            (propTok.value === 'top' || propTok.value === 'parent') &&
            isDotToken(nextDot) &&
            nextProp &&
            nextProp.kind === 'id' &&
            nextProp.value === 'location'
          ) {
            const targetVar = propTok.value === 'top' ? 'window.__yamalTop' : 'window.__yamalParent';
            const rep =
              nextDot.value === '?.'
                ? `(${targetVar} == null ? void 0 : window.__yLoc(${targetVar}))`
                : `window.__yLoc(${targetVar})`;
            edits.push({ start: tok.start, end: nextProp.end, text: rep });
            lastEditEnd = nextProp.end;
            i += 4;
            continue;
          }

          edits.push({ start: propTok.start, end: propTok.end, text: propMap[propTok.value] });
          lastEditEnd = propTok.end;
          i += 2;
          continue;
        }
      }
    }

    // Bare `location` member access: location.href, location?.href, location['search'], location.reload()
    if (tok.kind === 'id' && tok.value === 'location' && tok.start >= lastEditEnd) {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const precededByDot = isDotToken(prev);
      const precededByDecl = Boolean(prev && prev.kind === 'id' && DECL_KEYWORDS.has(prev.value));
      const followedByMember =
        Boolean(next) &&
        (isDotToken(next) || (next.kind === 'punc' && next.value === '['));
      if (!precededByDot && !precededByDecl && followedByMember) {
        edits.push({ start: tok.start, end: tok.end, text: 'window.__yBareLoc(location)' });
        lastEditEnd = tok.end;
        continue;
      }
    }

    // Generic identifier-chain member access: e.location, E.document.location, s.parent, e?.location
    if (
      isDotToken(tok) &&
      tokens[i + 1] &&
      tokens[i + 1].kind === 'id' &&
      VIRTUAL_PROPS.has(tokens[i + 1].value)
    ) {
      const propTok = tokens[i + 1];
      const afterTok = tokens[i + 2];
      if (
        (afterTok && afterTok.kind === 'punc' && afterTok.value === '(') ||
        isAssignOrIncToken(afterTok) ||
        (afterTok && afterTok.kind === 'id' && (afterTok.value === 'in' || afterTok.value === 'of'))
      ) {
        continue;
      }

      // Trace backwards across simple `ident (. ident)*` chain
      let chainStart = i - 1;
      if (chainStart < 0 || tokens[chainStart].kind !== 'id') continue;
      while (
        chainStart >= 2 &&
        tokens[chainStart - 1].kind === 'punc' &&
        tokens[chainStart - 1].value === '.' &&
        tokens[chainStart - 2].kind === 'id'
      ) {
        chainStart -= 2;
      }

      const startTok = tokens[chainStart];
      if (startTok.start < lastEditEnd) continue;
      if (startTok.value === 'new' || startTok.value === 'import') continue;

      const beforeChain = tokens[chainStart - 1];
      if (
        isDotToken(beforeChain) ||
        (beforeChain && beforeChain.kind === 'punc' && (beforeChain.value === ')' || beforeChain.value === ']')) ||
        (beforeChain &&
          beforeChain.kind === 'id' &&
          (DECL_KEYWORDS.has(beforeChain.value) || beforeChain.value === 'delete' || beforeChain.value === 'new'))
      ) {
        continue;
      }

      const exprSrc = code.slice(startTok.start, tokens[i - 1].end);
      const helper = helperMap[propTok.value];
      const replacement =
        tok.value === '?.'
          ? `(${exprSrc} == null ? void 0 : window.${helper}(${exprSrc}))`
          : `window.${helper}(${exprSrc})`;

      edits.push({ start: startTok.start, end: propTok.end, text: replacement });
      lastEditEnd = propTok.end;
      i += 1;
    }
  }

  if (edits.length === 0) return code;

  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += code.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += code.slice(cursor);
  return out;
}

interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expiresAt?: number;
  httpOnly: boolean;
  secure: boolean;
}

const sessionCookieJars = new Map<string, StoredCookie[]>();
let latestTikTokCookieHeader = '';

function getOrCreateSessionId(req: Request, res: Response): string {
  const existing = readCookie(req.headers.cookie, 'yamal_sid');
  if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) {
    return existing;
  }
  const sid = crypto.randomUUID();
  const isHttps =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    (typeof req.headers.origin === 'string' && req.headers.origin.startsWith('https://')) ||
    (typeof req.headers.referer === 'string' && req.headers.referer.startsWith('https://'));
  res.cookie('yamal_sid', sid, {
    path: '/',
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    httpOnly: true,
  });
  return sid;
}

function storeUpstreamCookies(sid: string, targetUrl: URL, setCookieHeaders: string[]): void {
  if (!setCookieHeaders || setCookieHeaders.length === 0) return;
  let jar = sessionCookieJars.get(sid);
  if (!jar) {
    jar = [];
    sessionCookieJars.set(sid, jar);
  }
  const now = Date.now();
  const reqHost = targetUrl.hostname.toLowerCase();
  if (reqHost === 'tiktok.com' || reqHost.endsWith('.tiktok.com')) {
    const pairs = setCookieHeaders.map((h) => h.split(';')[0].trim()).filter(Boolean);
    if (pairs.length > 0) {
      latestTikTokCookieHeader = pairs.join('; ');
    }
  }

  for (const rawHeader of setCookieHeaders) {
    const parts = rawHeader.split(';').map((p) => p.trim());
    const nameValue = parts[0] || '';
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();

    let domain = reqHost;
    let cookiePath = '/';
    let expiresAt: number | undefined;
    let httpOnly = false;
    let secure = false;

    for (let i = 1; i < parts.length; i += 1) {
      const attr = parts[i];
      const aEq = attr.indexOf('=');
      const attrName = (aEq === -1 ? attr : attr.slice(0, aEq)).trim().toLowerCase();
      const attrVal = aEq === -1 ? '' : attr.slice(aEq + 1).trim();
      if (attrName === 'domain' && attrVal) {
        const cleanDom = attrVal.replace(/^\.+/, '').toLowerCase();
        if (reqHost === cleanDom || reqHost.endsWith(`.${cleanDom}`)) {
          domain = cleanDom;
        }
      } else if (attrName === 'path' && attrVal.startsWith('/')) {
        cookiePath = attrVal;
      } else if (attrName === 'max-age' && attrVal !== '') {
        const secs = Number(attrVal);
        if (Number.isFinite(secs)) {
          expiresAt = secs <= 0 ? 0 : now + secs * 1000;
        }
      } else if (attrName === 'expires' && attrVal && expiresAt === undefined) {
        const ts = Date.parse(attrVal);
        if (!Number.isNaN(ts)) expiresAt = ts;
      } else if (attrName === 'httponly') {
        httpOnly = true;
      } else if (attrName === 'secure') {
        secure = true;
      }
    }

    const idx = jar.findIndex(
      (c) => c.name === name && c.domain === domain && c.path === cookiePath
    );
    if (expiresAt !== undefined && expiresAt <= now) {
      if (idx !== -1) jar.splice(idx, 1);
      continue;
    }

    const entry: StoredCookie = {
      name,
      value,
      domain,
      path: cookiePath,
      expiresAt,
      httpOnly,
      secure,
    };
    if (idx !== -1) jar[idx] = entry;
    else jar.push(entry);
  }

  if (jar.length > 200) {
    sessionCookieJars.set(sid, jar.slice(-200));
  }
}

function getMatchingCookies(sid: string, targetUrl: URL, includeHttpOnly: boolean): StoredCookie[] {
  const jar = sessionCookieJars.get(sid);
  if (!jar || jar.length === 0) return [];
  const now = Date.now();
  const host = targetUrl.hostname.toLowerCase();
  const reqPath = targetUrl.pathname || '/';
  const isHttps = targetUrl.protocol === 'https:';

  return jar.filter((c) => {
    if (c.expiresAt !== undefined && c.expiresAt <= now) return false;
    if (c.secure && !isHttps) return false;
    if (!includeHttpOnly && c.httpOnly) return false;
    const domainMatch = host === c.domain || host.endsWith(`.${c.domain}`);
    const pathMatch = reqPath.startsWith(c.path);
    return domainMatch && pathMatch;
  });
}

function isNowggHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'now.gg' || host.endsWith('.now.gg') || host === 'doctoraux.com' || host.endsWith('.doctoraux.com');
}

function isNowggCloudFrontProxyError(target: URL, upstream: globalThis.Response, body: string): boolean {
  if (!isNowggHost(target.hostname)) return false;
  const server = (upstream.headers.get('server') || '').toLowerCase();
  const xCache = (upstream.headers.get('x-cache') || '').toLowerCase();
  const looksCloudFrontS3 = server === 'amazons3' || xCache.includes('cloudfront');
  if (!looksCloudFrontS3) return false;
  return (
    body.includes('/error-page/proxy') ||
    body.includes('Proxy/VPN Detected') ||
    (upstream.status === 403 && body.includes('<Code>AccessDenied</Code>'))
  );
}

function buildNowggOapiFallbackJson(pathname: string): Record<string, unknown> {
  if (pathname.endsWith('/push')) {
    return {
      status: 'Success',
      clientIpInfo: {
        browserCode: 'desk',
        countryCode: 'US',
      },
    };
  }
  if (pathname.endsWith('/createPlayUser')) {
    return {
      status: 'SuccessUserCreated',
      playUserToken: `pu_${crypto.randomBytes(12).toString('hex')}`,
      subscriptionInfo: { isPremium: false },
      nowbuxCreditLimitExceeded: false,
    };
  }
  if (pathname.endsWith('/getAppPlayFeatures')) {
    return {
      status: 'Success',
      enableLiveChat: false,
    };
  }
  if (pathname.endsWith('/getMaintenanceStatus')) {
    return {
      status: 'Success',
      underMaintenance: false,
    };
  }
  if (pathname.endsWith('/getPreference')) {
    return {
      status: 'Success',
      preferences: {},
    };
  }
  if (pathname.endsWith('/startSession') || pathname.endsWith('/setAnswerSdp')) {
    return {
      status: 'FailureProxyUserLimitExceeded',
      errCode: '3102',
      errMsg: 'now.gg cloud streaming blocked datacenter proxy IP on this endpoint.',
    };
  }
  return { status: 'Success' };
}

function sanitizeNowggJsonResponse(pathname: string, rawText: string): string {
  if (!pathname.endsWith('/push')) return rawText;
  try {
    const parsed = JSON.parse(rawText) as { clientIpInfo?: { browserCode?: string; ipv4?: string } };
    if (parsed && typeof parsed === 'object' && parsed.clientIpInfo) {
      parsed.clientIpInfo.browserCode = 'desk';
      if (parsed.clientIpInfo.ipv4) {
        parsed.clientIpInfo.ipv4 = '0.0.0.0';
      }
      return JSON.stringify(parsed);
    }
  } catch {
    // Keep original JSON text
  }
  return rawText;
}

function buildInjectedClientScript(
  targetUrl: string,
  initialClientCookies: Array<{ name: string; value: string }> = [],
  baseUri?: string
): string {
  const safeTargetJson = JSON.stringify(targetUrl);
  const safeBaseUriJson = JSON.stringify(baseUri || targetUrl);
  const safeCookiesJson = JSON.stringify(initialClientCookies);
  return `<script data-unblocker="true">
(function() {
  var BASE_URL = ${safeTargetJson};
  var BASE_URI = ${safeBaseUriJson};
  var PROXY_PREFIX = '/api/proxy?url=';
  var INITIAL_COOKIES = ${safeCookiesJson};

  var realWindow = window;
  var realParent = window.parent;
  var realTop = window.top;
  var realLocation = window.location;
  var realOrigin = realLocation.origin;
  var origFnToString = Function.prototype.toString;
  var nativeStringMap = new WeakMap();

  function markNative(fn, name) {
    if (typeof fn === 'function') {
      nativeStringMap.set(fn, 'function ' + (name || fn.name || '') + '() { [native code] }');
    }
    return fn;
  }

  try {
    var patchedToString = function toString() {
      if (nativeStringMap.has(this)) {
        return nativeStringMap.get(this);
      }
      return origFnToString.call(this);
    };
    nativeStringMap.set(patchedToString, 'function toString() { [native code] }');
    Object.defineProperty(Function.prototype, 'toString', {
      configurable: true,
      writable: true,
      value: patchedToString
    });
  } catch (e) {}

  var depth = 0;
  try {
    if (realParent && realParent !== realWindow && realParent.__yamalIsProxied) {
      depth = (typeof realParent.__yamalDepth === 'number' ? realParent.__yamalDepth : 0) + 1;
    }
  } catch (e) {}

  realWindow.__yamalIsProxied = true;
  realWindow.__yamalDepth = depth;
  realWindow.__yamalSelf = realWindow;
  realWindow.__yamalFrameElement = null;

  var virtualParent = depth > 0 ? realParent : realWindow;
  var virtualTop = depth > 0 && realParent && realParent.__yamalTop ? realParent.__yamalTop : realWindow;
  realWindow.__yamalParent = virtualParent;
  realWindow.__yamalTop = virtualTop;

  function parseBase() {
    try {
      return new URL(BASE_URL);
    } catch (e) {
      return new URL(realLocation.href);
    }
  }

  Object.defineProperty(realWindow, '__yamalOrigin', {
    configurable: true,
    get: function() { return parseBase().origin; }
  });

  function toVirtualPath(absUrl) {
    try {
      var p = new URL(absUrl);
      var pathStr = (p.pathname || '/') + (p.search || '') + (p.hash || '');
      if (pathStr.indexOf('/api/proxy') === 0 || pathStr === '/unblocker.html' || pathStr === '/index.html') {
        return null;
      }
      return pathStr;
    } catch (e) {
      return null;
    }
  }

  function toAbs(raw) {
    if (raw == null) return null;
    var s = String(raw).trim();
    if (!s || s.charAt(0) === '#' || s.indexOf(PROXY_PREFIX) === 0 || s.indexOf(realOrigin + PROXY_PREFIX) === 0) {
      return null;
    }
    if (/^(javascript|mailto|tel|sms|data|blob|about):/i.test(s)) return null;
    var refBase = BASE_URI || BASE_URL;
    try {
      var u = new URL(s, refBase);
      if (u.origin === realOrigin) {
        if (u.pathname === '/api/proxy' && u.searchParams.has('url')) {
          return null;
        }
        u = new URL(u.pathname + u.search + u.hash, refBase);
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u.toString();
    } catch (e) {
      return null;
    }
  }

  function wrapUrl(raw) {
    var abs = toAbs(raw);
    return abs ? PROXY_PREFIX + encodeURIComponent(abs) : raw;
  }

  function unwrapUrl(maybeProxied) {
    try {
      var u = new URL(maybeProxied, realOrigin);
      if (u.pathname === '/api/proxy' && u.searchParams.has('url')) {
        return u.searchParams.get('url');
      }
    } catch (e) {}
    return maybeProxied;
  }

  function navigateVirtual(rawUrl, useReplace) {
    var s = String(rawUrl == null ? '' : rawUrl);
    if (s.charAt(0) === '#') {
      var uHash = parseBase();
      uHash.hash = s;
      BASE_URL = uHash.toString();
      try { realLocation.hash = s; } catch (e) {}
      return;
    }
    var abs = toAbs(unwrapUrl(s)) || BASE_URL;
    var dest = PROXY_PREFIX + encodeURIComponent(abs);
    if (useReplace) realLocation.replace(dest);
    else realLocation.href = dest;
  }

  var ancestorOriginsMock = {
    length: 0,
    item: function() { return null; },
    contains: function() { return false; }
  };

  var locationObj = {
    get href() { return parseBase().href; },
    set href(val) { navigateVirtual(val, false); },
    get origin() { return parseBase().origin; },
    get protocol() { return parseBase().protocol; },
    set protocol(val) {
      var u = parseBase();
      u.protocol = String(val);
      navigateVirtual(u.toString(), false);
    },
    get host() { return parseBase().host; },
    set host(val) {
      var u = parseBase();
      u.host = String(val);
      navigateVirtual(u.toString(), false);
    },
    get hostname() { return parseBase().hostname; },
    set hostname(val) {
      var u = parseBase();
      u.hostname = String(val);
      navigateVirtual(u.toString(), false);
    },
    get port() { return parseBase().port; },
    set port(val) {
      var u = parseBase();
      u.port = String(val);
      navigateVirtual(u.toString(), false);
    },
    get pathname() { return parseBase().pathname; },
    set pathname(val) {
      var u = parseBase();
      u.pathname = String(val);
      navigateVirtual(u.toString(), false);
    },
    get search() { return parseBase().search; },
    set search(val) {
      var u = parseBase();
      u.search = String(val);
      navigateVirtual(u.toString(), false);
    },
    get hash() { return parseBase().hash; },
    set hash(val) { navigateVirtual(String(val).charAt(0) === '#' ? String(val) : '#' + String(val), false); },
    get ancestorOrigins() { return ancestorOriginsMock; },
    assign: markNative(function assign(url) { navigateVirtual(url, false); }, 'assign'),
    replace: markNative(function replace(url) { navigateVirtual(url, true); }, 'replace'),
    reload: markNative(function reload() { realLocation.replace(PROXY_PREFIX + encodeURIComponent(BASE_URL)); }, 'reload'),
    toString: markNative(function toString() { return parseBase().href; }, 'toString'),
    valueOf: markNative(function valueOf() { return locationObj; }, 'valueOf')
  };

  Object.defineProperty(realWindow, '__yamalLocation', {
    configurable: true,
    get: function() { return locationObj; },
    set: function(val) { navigateVirtual(val, false); }
  });

  try {
    Object.defineProperty(document, '__yamalLocation', {
      configurable: true,
      get: function() { return locationObj; },
      set: function(val) { navigateVirtual(val, false); }
    });
  } catch (e) {}

  realWindow.__yLoc = function(obj) {
    if (obj === realWindow || obj === document || obj === realTop || obj === realParent || obj === realLocation) {
      return locationObj;
    }
    if (obj && obj.__yamalLocation) {
      return obj.__yamalLocation;
    }
    return obj && obj.location;
  };
  realWindow.__yBareLoc = function(obj) {
    if (obj === realLocation) return locationObj;
    return obj;
  };
  realWindow.__yTop = function(obj) {
    if (obj === realWindow) return virtualTop;
    if (obj && obj.__yamalTop) return obj.__yamalTop;
    return obj && obj.top;
  };
  realWindow.__yParent = function(obj) {
    if (obj === realWindow) return virtualParent;
    if (obj && obj.__yamalParent) return obj.__yamalParent;
    return obj && obj.parent;
  };
  realWindow.__yFrame = function(obj) {
    if (obj === realWindow) return null;
    if (obj && obj.__yamalIsProxied) return null;
    return obj && obj.frameElement;
  };

  // Spoof document URL, baseURI, referrer, domain, cookie, and navigator.webdriver
  try {
    var getDocUrl = markNative(function getURL() { return parseBase().href; }, 'get URL');
    var getBaseUri = markNative(function getBaseURI() { return BASE_URI || parseBase().href; }, 'get baseURI');
    Object.defineProperty(document, 'URL', { configurable: true, get: getDocUrl });
    Object.defineProperty(document, 'documentURI', { configurable: true, get: getDocUrl });
    Object.defineProperty(document, 'baseURI', { configurable: true, get: getBaseUri });
    if (typeof Node !== 'undefined' && Node.prototype) {
      var origNodeBaseDesc = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI');
      if (origNodeBaseDesc && origNodeBaseDesc.get) {
        Object.defineProperty(Node.prototype, 'baseURI', {
          configurable: true,
          enumerable: origNodeBaseDesc.enumerable,
          get: markNative(function baseURI() {
            if (this === document || (this && this.ownerDocument === document)) {
              return BASE_URI || parseBase().href;
            }
            return origNodeBaseDesc.get.call(this);
          }, 'get baseURI')
        });
      }
    }
    Object.defineProperty(document, 'domain', {
      configurable: true,
      get: markNative(function getDomain() { return parseBase().hostname; }, 'get domain'),
      set: markNative(function setDomain() {}, 'set domain')
    });
    var refStorageKey = '__yamal_ref__' + parseBase().hostname;
    var virtualReferrer = '';
    try {
      var savedRef = sessionStorage.getItem(refStorageKey);
      if (savedRef && savedRef.indexOf(realOrigin) !== 0) {
        virtualReferrer = savedRef;
      }
      if (!virtualReferrer && (parseBase().hostname === 'now.gg' || parseBase().hostname.endsWith('.now.gg'))) {
        virtualReferrer = parseBase().origin + '/';
        if (parseBase().pathname.indexOf('/apps/') === 0 || parseBase().pathname.indexOf('/play/') === 0) {
          sessionStorage.setItem('allowFpsRotation', 'true');
        }
      }
      sessionStorage.setItem(refStorageKey, parseBase().origin + '/');
    } catch (e) {}
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      get: markNative(function getReferrer() { return virtualReferrer; }, 'get referrer')
    });
  } catch (e) {}

  try {
    var cookieStoreKey = '__yamal_vcookie__' + parseBase().hostname;
    var vCookies = {};
    try {
      var storedRaw = sessionStorage.getItem(cookieStoreKey);
      if (storedRaw) vCookies = JSON.parse(storedRaw) || {};
    } catch (e) {}
    for (var ci = 0; ci < INITIAL_COOKIES.length; ci += 1) {
      var ck = INITIAL_COOKIES[ci];
      if (ck && ck.name) vCookies[ck.name] = ck.value;
    }
    try { sessionStorage.setItem(cookieStoreKey, JSON.stringify(vCookies)); } catch (e) {}

    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: markNative(function getCookie() {
        var pairs = [];
        for (var k in vCookies) {
          if (Object.prototype.hasOwnProperty.call(vCookies, k) && k.indexOf('yamal_') !== 0) {
            pairs.push(k + '=' + vCookies[k]);
          }
        }
        return pairs.join('; ');
      }, 'get cookie'),
      set: markNative(function setCookie(rawStr) {
        try {
          var str = String(rawStr || '');
          var semi = str.indexOf(';');
          var nv = (semi === -1 ? str : str.slice(0, semi)).trim();
          var eq = nv.indexOf('=');
          if (eq <= 0) return;
          var name = nv.slice(0, eq).trim();
          var val = nv.slice(eq + 1).trim();
          if (/max-age\s*=\s*0/i.test(str) || /max-age\s*=\s*-/i.test(str)) {
            delete vCookies[name];
          } else {
            vCookies[name] = val;
          }
          try { sessionStorage.setItem(cookieStoreKey, JSON.stringify(vCookies)); } catch (e) {}
        } catch (e) {}
      }, 'set cookie')
    });
  } catch (e) {}

  try {
    Object.defineProperty(navigator, 'webdriver', {
      configurable: true,
      get: markNative(function getWebdriver() { return false; }, 'get webdriver')
    });
  } catch (e) {}

  function notifyParent() {
    if (depth > 0) return;
    try {
      realParent.postMessage({
        type: 'unblocker:loaded',
        url: BASE_URL,
        title: document.title || BASE_URL
      }, '*');
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', notifyParent);
  } else {
    notifyParent();
  }
  realWindow.addEventListener('load', notifyParent);

  if (realWindow.MutationObserver && document.documentElement) {
    var titleObserver = new MutationObserver(notifyParent);
    titleObserver.observe(document.documentElement, { subtree: true, childList: true });
  }

  // Normalize postMessage cross-iframe targetOrigin & MessageEvent.origin inside Yamal
  try {
    var origWinPostMessage = realWindow.postMessage.bind(realWindow);
    realWindow.postMessage = markNative(function postMessage(message, targetOrigin, transfer) {
      var safeTarget = targetOrigin;
      if (typeof targetOrigin === 'string' && targetOrigin !== '*' && targetOrigin !== '/') {
        safeTarget = realOrigin;
      }
      if (arguments.length >= 3) return origWinPostMessage(message, safeTarget, transfer);
      return origWinPostMessage(message, safeTarget);
    }, 'postMessage');

    if (typeof MessageEvent !== 'undefined' && MessageEvent.prototype) {
      var origMsgOriginDesc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin');
      if (origMsgOriginDesc && origMsgOriginDesc.get) {
        Object.defineProperty(MessageEvent.prototype, 'origin', {
          configurable: true,
          enumerable: origMsgOriginDesc.enumerable,
          get: markNative(function getOrigin() {
            var rawOrigin = origMsgOriginDesc.get.call(this);
            try {
              if (rawOrigin === realOrigin && this.source && this.source !== realParent && this.source.__yamalOrigin) {
                return this.source.__yamalOrigin;
              }
            } catch (e) {}
            return rawOrigin;
          }, 'get origin')
        });
      }
    }
  } catch (e) {}

  // Prevent sites from registering rogue service workers on our proxy origin
  if (navigator && navigator.serviceWorker) {
    try {
      navigator.serviceWorker.register = markNative(function register() {
        return Promise.resolve({});
      }, 'register');
      navigator.serviceWorker.getRegistrations = markNative(function getRegistrations() {
        return Promise.resolve([]);
      }, 'getRegistrations');
      navigator.serviceWorker.getRegistration = markNative(function getRegistration() {
        return Promise.resolve(undefined);
      }, 'getRegistration');
    } catch (e) {}
  }

  // Restore target pathname/search/hash immediately so SPA routers and relative CSS/HTML paths
  // resolve against the real base directory instead of "/api/proxy".
  if (realWindow.history) {
    var origPush = realWindow.history.pushState.bind(realWindow.history);
    var origReplace = realWindow.history.replaceState.bind(realWindow.history);

    var initialVirtual = toVirtualPath(BASE_URI || BASE_URL);
    if (initialVirtual) {
      try {
        origReplace(realWindow.history.state, '', initialVirtual);
      } catch (e) {}
    }

    function wrapHistoryState(fn, fnName) {
      return markNative(function(state, title, url) {
        if (url && typeof url === 'string') {
          var unwrapped = unwrapUrl(url);
          var prevOrigin = '';
          try { prevOrigin = new URL(BASE_URL).origin; } catch (e) {}
          var abs = toAbs(unwrapped) || BASE_URL;
          var nextOrigin = '';
          try { nextOrigin = new URL(abs).origin; } catch (e) {}

          if (prevOrigin && nextOrigin && prevOrigin !== nextOrigin) {
            realLocation.href = PROXY_PREFIX + encodeURIComponent(abs);
            return;
          }

          BASE_URL = abs;
          notifyParent();
          var nextVirtual = toVirtualPath(abs);
          try {
            return fn(state, title, nextVirtual || (PROXY_PREFIX + encodeURIComponent(abs)));
          } catch (e) {
            return;
          }
        }
        return fn(state, title, url);
      }, fnName);
    }

    realWindow.history.pushState = wrapHistoryState(origPush, 'pushState');
    realWindow.history.replaceState = wrapHistoryState(origReplace, 'replaceState');
  }

  // Intercept dynamic element src / href assignments (including TrustedScriptURL objects) and setAttribute calls
  function patchAttrProp(Ctor, prop, unwrapOnGet) {
    if (!Ctor || !Ctor.prototype) return;
    var desc = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
    if (!desc || !desc.set || !desc.get) return;
    Object.defineProperty(Ctor.prototype, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: markNative(function() {
        var val = desc.get.call(this);
        return unwrapOnGet && typeof val === 'string' ? unwrapUrl(val) : val;
      }, 'get ' + prop),
      set: markNative(function(val) {
        if (val == null) return desc.set.call(this, val);
        return desc.set.call(this, wrapUrl(String(val)));
      }, 'set ' + prop)
    });
  }

  patchAttrProp(realWindow.HTMLScriptElement, 'src', true);
  patchAttrProp(realWindow.HTMLImageElement, 'src', true);
  patchAttrProp(realWindow.HTMLLinkElement, 'href', true);
  patchAttrProp(realWindow.HTMLIFrameElement, 'src', true);
  patchAttrProp(realWindow.HTMLMediaElement, 'src', true);
  patchAttrProp(realWindow.HTMLSourceElement, 'src', true);
  patchAttrProp(realWindow.HTMLFormElement, 'action', true);
  patchAttrProp(realWindow.HTMLAnchorElement, 'href', true);
  patchAttrProp(realWindow.HTMLAreaElement, 'href', true);

  if (realWindow.HTMLAnchorElement && realWindow.HTMLAnchorElement.prototype) {
    var rawAnchorHrefDesc = Object.getOwnPropertyDescriptor(realWindow.HTMLAnchorElement.prototype, 'href');
    ['origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'].forEach(function(urlProp) {
      var pDesc = Object.getOwnPropertyDescriptor(realWindow.HTMLAnchorElement.prototype, urlProp);
      if (!pDesc || !pDesc.get) return;
      Object.defineProperty(realWindow.HTMLAnchorElement.prototype, urlProp, {
        configurable: true,
        enumerable: pDesc.enumerable,
        get: markNative(function() {
          try {
            var cur = rawAnchorHrefDesc && rawAnchorHrefDesc.get ? rawAnchorHrefDesc.get.call(this) : '';
            if (typeof cur === 'string' && cur) {
              return new URL(cur)[urlProp];
            }
          } catch (e) {}
          return pDesc.get.call(this);
        }, 'get ' + urlProp)
      });
    });
  }

  if (realWindow.Element && realWindow.Element.prototype && realWindow.Element.prototype.setAttribute) {
    var origSetAttribute = realWindow.Element.prototype.setAttribute;
    var URL_ATTR_TAGS = {
      SCRIPT: { src: 1 },
      IMG: { src: 1, 'data-src': 1 },
      LINK: { href: 1 },
      IFRAME: { src: 1 },
      SOURCE: { src: 1 },
      VIDEO: { src: 1, poster: 1 },
      AUDIO: { src: 1 },
      TRACK: { src: 1 },
      EMBED: { src: 1 },
      FORM: { action: 1 },
      A: { href: 1 },
      AREA: { href: 1 }
    };
    realWindow.Element.prototype.setAttribute = markNative(function setAttribute(name, value) {
      try {
        var lower = String(name).toLowerCase();
        var tagMap = URL_ATTR_TAGS[this.tagName];
        if (tagMap && tagMap[lower] && value != null) {
          return origSetAttribute.call(this, name, wrapUrl(String(value)));
        }
      } catch (e) {}
      return origSetAttribute.call(this, name, value);
    }, 'setAttribute');
  }

  // Wrap Worker / SharedWorker script URLs onto proxy
  if (typeof realWindow.Worker === 'function') {
    var OrigWorker = realWindow.Worker;
    realWindow.Worker = markNative(function Worker(scriptURL, options) {
      var wrappedWorkerUrl = scriptURL != null ? wrapUrl(String(scriptURL)) : scriptURL;
      return options !== undefined ? new OrigWorker(wrappedWorkerUrl, options) : new OrigWorker(wrappedWorkerUrl);
    }, 'Worker');
    realWindow.Worker.prototype = OrigWorker.prototype;
  }
  if (typeof realWindow.SharedWorker === 'function') {
    var OrigSharedWorker = realWindow.SharedWorker;
    realWindow.SharedWorker = markNative(function SharedWorker(scriptURL, options) {
      var wrappedWorkerUrl = scriptURL != null ? wrapUrl(String(scriptURL)) : scriptURL;
      return options !== undefined ? new OrigSharedWorker(wrappedWorkerUrl, options) : new OrigSharedWorker(wrappedWorkerUrl);
    }, 'SharedWorker');
    realWindow.SharedWorker.prototype = OrigSharedWorker.prototype;
  }

  // Intercept link clicks dynamically
  document.addEventListener('click', function(ev) {
    var el = ev.target;
    while (el && el.tagName !== 'A') {
      el = el.parentElement;
    }
    if (!el) return;
    var href = el.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^(javascript|mailto|tel|sms):/i.test(href)) return;
    if (href.indexOf(PROXY_PREFIX) === 0) {
      if (el.getAttribute('target') === '_blank') {
        ev.preventDefault();
        realLocation.href = href;
      }
      return;
    }
    var abs = toAbs(href);
    if (abs) {
      ev.preventDefault();
      realLocation.href = PROXY_PREFIX + encodeURIComponent(abs);
    }
  }, true);

  // Intercept GET/POST form submissions
  document.addEventListener('submit', function(ev) {
    var form = ev.target;
    if (!form || form.tagName !== 'FORM') return;
    var rawAction = form.getAttribute('action') || BASE_URL;
    var unwrappedAction = unwrapUrl(rawAction);
    var absAction = toAbs(unwrappedAction) || BASE_URL;
    var method = (form.getAttribute('method') || 'GET').toUpperCase();

    if (method === 'GET') {
      ev.preventDefault();
      try {
        var target = new URL(absAction);
        var fd = new FormData(form);
        fd.forEach(function(value, key) {
          if (typeof value === 'string') {
            target.searchParams.append(key, value);
          }
        });
        realLocation.href = PROXY_PREFIX + encodeURIComponent(target.toString());
      } catch (e) {}
    } else {
      form.setAttribute('action', PROXY_PREFIX + encodeURIComponent(absAction));
    }
  }, true);

  // Redirect window.open inside current frame
  realWindow.open = markNative(function open(url) {
    if (url) {
      realLocation.href = wrapUrl(String(url));
    }
    return realWindow;
  }, 'open');

  // Patch navigator.sendBeacon
  if (navigator && typeof navigator.sendBeacon === 'function') {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = markNative(function sendBeacon(url, data) {
      return origBeacon(typeof url === 'string' ? wrapUrl(url) : url, data);
    }, 'sendBeacon');
  }

  function wrapFetchResponse(resPromise) {
    return resPromise.then(function(response) {
      try {
        var origResUrl = response.url;
        if (origResUrl && origResUrl.indexOf('/api/proxy') !== -1) {
          Object.defineProperty(response, 'url', {
            configurable: true,
            get: function() { return unwrapUrl(origResUrl); }
          });
        }
      } catch (e) {}
      return response;
    });
  }

  // Patch fetch safely for strings, URL objects, and Request objects (preserving POST bodies without duplex errors)
  if (realWindow.fetch) {
    var origFetch = realWindow.fetch.bind(realWindow);
    realWindow.fetch = markNative(function fetch(input, init) {
      if (typeof input === 'string') {
        return wrapFetchResponse(origFetch(wrapUrl(input), init));
      }
      if (typeof URL !== 'undefined' && input instanceof URL) {
        return wrapFetchResponse(origFetch(wrapUrl(input.href), init));
      }
      if (input && typeof input === 'object' && input.url) {
        var wrapped = wrapUrl(String(input.url));
        if (wrapped !== input.url) {
          var method = ((init && init.method) || input.method || 'GET').toUpperCase();
          var baseOpts = {
            method: method,
            headers: (init && init.headers) || input.headers,
            credentials: (init && init.credentials) || input.credentials,
            redirect: (init && init.redirect) || input.redirect
          };
          if (init && init.signal) baseOpts.signal = init.signal;
          else if (input.signal) baseOpts.signal = input.signal;

          if (init && init.body !== undefined) {
            baseOpts.body = init.body;
            return wrapFetchResponse(origFetch(wrapped, baseOpts));
          }
          if (method !== 'GET' && method !== 'HEAD') {
            try {
              var cloned = input.clone();
              return cloned.arrayBuffer().then(function(buf) {
                if (buf && buf.byteLength > 0) {
                  baseOpts.body = buf;
                }
                return wrapFetchResponse(origFetch(wrapped, baseOpts));
              });
            } catch (e) {
              return wrapFetchResponse(origFetch(wrapped, baseOpts));
            }
          }
          return wrapFetchResponse(origFetch(wrapped, baseOpts));
        }
      }
      return wrapFetchResponse(origFetch(input, init));
    }, 'fetch');
  }

  // Patch XMLHttpRequest
  if (realWindow.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = markNative(function open(method, url) {
      var args = Array.prototype.slice.call(arguments);
      if (url != null) {
        args[1] = wrapUrl(String(url));
      }
      return origOpen.apply(this, args);
    }, 'open');

    var origXhrUrlDesc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseURL');
    if (origXhrUrlDesc && origXhrUrlDesc.get) {
      Object.defineProperty(XMLHttpRequest.prototype, 'responseURL', {
        configurable: true,
        enumerable: origXhrUrlDesc.enumerable,
        get: markNative(function getResponseURL() {
          var raw = origXhrUrlDesc.get.call(this);
          return raw ? unwrapUrl(raw) : raw;
        }, 'get responseURL')
      });
    }
  }
  // Normalize Cache / CacheStorage keys to canonical upstream URLs (needed by UnityCache)
  try {
    function normalizeCacheReq(req) {
      if (typeof req === 'string') {
        var unwrapped = unwrapUrl(req);
        return toAbs(unwrapped) || unwrapped;
      }
      if (req && typeof req === 'object' && req.url) {
        var u = unwrapUrl(req.url);
        var abs = toAbs(u);
        if (abs && abs !== req.url) return abs;
        if (u !== req.url) return u;
      }
      return req;
    }
    if (typeof Cache !== 'undefined' && Cache.prototype) {
      ['match', 'matchAll', 'put', 'add', 'delete'].forEach(function(mName) {
        var origFn = Cache.prototype[mName];
        if (typeof origFn !== 'function') return;
        Cache.prototype[mName] = markNative(function(req) {
          var args = Array.prototype.slice.call(arguments);
          if (args.length > 0) args[0] = normalizeCacheReq(args[0]);
          return origFn.apply(this, args);
        }, mName);
      });
    }
    if (typeof CacheStorage !== 'undefined' && CacheStorage.prototype && typeof CacheStorage.prototype.match === 'function') {
      var origCsMatch = CacheStorage.prototype.match;
      CacheStorage.prototype.match = markNative(function match(req) {
        var args = Array.prototype.slice.call(arguments);
        if (args.length > 0) args[0] = normalizeCacheReq(args[0]);
        return origCsMatch.apply(this, args);
      }, 'match');
    }
  } catch (e) {}
})();
</script>`;
}

function isJsScriptType(attrs: string): boolean {
  const typeMatch = attrs.match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  if (!typeMatch) return true;
  const val = (typeMatch[1] ?? typeMatch[2] ?? typeMatch[3] ?? '').trim().toLowerCase();
  if (!val) return true;
  return (
    val === 'text/javascript' ||
    val === 'application/javascript' ||
    val === 'application/ecmascript' ||
    val === 'text/ecmascript' ||
    val === 'module'
  );
}

function rewriteHtml(
  html: string,
  targetUrl: string,
  initialClientCookies: Array<{ name: string; value: string }> = []
): string {
  // Respect <base href="..."> if declared before stripping it
  let effectiveBase = targetUrl;
  const baseMatch = html.match(/<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
  if (baseMatch) {
    const rawBase = decodeHtmlEntities(baseMatch[1] ?? baseMatch[2] ?? baseMatch[3] ?? '').trim();
    const resolvedBase = resolveMaybeUrl(rawBase, targetUrl);
    if (resolvedBase) {
      effectiveBase = resolvedBase;
    }
  }

  let out = html
    .replace(
      /<meta[^>]*http-equiv\s*=\s*["']?\s*(content-security-policy|x-frame-options)\s*["']?[^>]*>/gi,
      ''
    )
    .replace(/<meta[^>]*name\s*=\s*["']?\s*referrer\s*["']?[^>]*>/gi, '')
    .replace(/<base\b[^>]*>/gi, '');

  // Rewrite <meta http-equiv="refresh" content="0;url=...">
  out = out.replace(
    /<meta\b([^>]*http-equiv\s*=\s*["']?\s*refresh\s*["']?[^>]*)>/gi,
    (_full, attrs) => {
      const updated = attrs.replace(
        /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
        (_cMatch: string, dq: string, sq: string) => {
          const val = decodeHtmlEntities(dq ?? sq ?? '');
          const nextVal = val.replace(/url\s*=\s*([^\s;]+)/i, (uMatch, rawUrl) => {
            const resolved = resolveMaybeUrl(rawUrl, effectiveBase);
            return resolved ? `url=${toProxyUrl(resolved)}` : uMatch;
          });
          return `content="${nextVal}"`;
        }
      );
      return `<meta${updated}>`;
    }
  );

  // Isolate <script> blocks so inline JS strings are never altered by HTML regexes
  const scriptPlaceholders: string[] = [];
  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_m, attrs, body) => {
    const rewrittenAttrs = rewriteTagAttributes(attrs, effectiveBase);
    const hasSrc = /\bsrc\s*=/i.test(attrs);
    const rewrittenBody =
      !hasSrc && body && isJsScriptType(attrs) ? rewriteJavaScript(body, effectiveBase) : body;
    const idx = scriptPlaceholders.length;
    scriptPlaceholders.push(`<script${rewrittenAttrs}>${rewrittenBody}</script>`);
    return `__YAMAL_SCRIPT_${idx}__`;
  });

  // Isolate <style> blocks and rewrite CSS url() / @import inside them
  const stylePlaceholders: string[] = [];
  out = out.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs, cssBody) => {
    const idx = stylePlaceholders.length;
    stylePlaceholders.push(`<style${attrs}>${rewriteCss(cssBody, effectiveBase)}</style>`);
    return `__YAMAL_STYLE_${idx}__`;
  });

  // Rewrite attributes on remaining HTML elements safely
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9:-]*)(\s+[^>]*?)(\/?)>/g, (_m, tag, attrs, selfClose) => {
    return `<${tag}${rewriteTagAttributes(attrs, effectiveBase)}${selfClose}>`;
  });

  // Restore <style> and <script> blocks
  out = out.replace(/__YAMAL_STYLE_(\d+)__/g, (_m, i) => stylePlaceholders[Number(i)] || '');
  out = out.replace(/__YAMAL_SCRIPT_(\d+)__/g, (_m, i) => scriptPlaceholders[Number(i)] || '');

  const injectedScript = buildInjectedClientScript(targetUrl, initialClientCookies, effectiveBase);
  const firstScriptMatch = /<script\b/i.exec(out);
  const headMatch = /<head\b[^>]*>/i.exec(out);

  if (headMatch && (!firstScriptMatch || headMatch.index < firstScriptMatch.index)) {
    const insertAt = headMatch.index + headMatch[0].length;
    out = `${out.slice(0, insertAt)}${injectedScript}${out.slice(insertAt)}`;
  } else if (firstScriptMatch) {
    const doctypeMatch = /<!doctype\s+html(?:\s+[^->][^>]*)?>/i.exec(out);
    if (doctypeMatch && doctypeMatch.index < firstScriptMatch.index) {
      const insertAt = doctypeMatch.index + doctypeMatch[0].length;
      out = `${out.slice(0, insertAt)}${injectedScript}${out.slice(insertAt)}`;
    } else {
      const insertAt = firstScriptMatch.index;
      out = `${out.slice(0, insertAt)}${injectedScript}${out.slice(insertAt)}`;
    }
  } else if (/<html\b[^>]*>/i.test(out)) {
    out = out.replace(/<html\b([^>]*)>/i, (_m, attrs) => `<html${attrs}><head>${injectedScript}</head>`);
  } else {
    out = `${injectedScript}${out}`;
  }

  return out;
}

function escapeHtml(str: string): string {
  return str.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[ch] || ch;
  });
}

function renderProxyErrorPage(targetUrl: string, reason: string, bingSearchUrl?: string): string {
  const escapedUrl = escapeHtml(targetUrl);
  const escapedReason = escapeHtml(reason);
  const bingBtn = bingSearchUrl
    ? `<a class="btn-alt" href="${toProxyUrl(bingSearchUrl)}">Search on Bing</a>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Unable to load page</title>
  <style>
    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: grid; place-items: center; min-height: 100vh; padding: 24px; }
    .card { max-width: 540px; width: 100%; background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 28px; }
    h1 { margin: 0 0 8px; font-size: 20px; font-weight: 700; }
    p { margin: 0 0 16px; color: #cbd5e1; font-size: 14px; line-height: 1.5; word-break: break-word; }
    .url { font-family: ui-monospace, monospace; font-size: 12px; color: #38bdf8; background: #0f172a; padding: 10px 12px; border-radius: 8px; margin-bottom: 18px; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    button, a { display: inline-block; text-decoration: none; background: #0bc2cf; color: #042f2e; font-weight: 700; border: 0; border-radius: 8px; padding: 10px 18px; cursor: pointer; font-size: 14px; }
    button:hover, a:hover { background: #22d3ee; }
    .btn-alt { background: #334155; color: #f8fafc; }
    .btn-alt:hover { background: #475569; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Could not load this website</h1>
    <div class="url">${escapedUrl}</div>
    <p>${escapedReason}</p>
    <div class="actions">
      <button onclick="window.location.reload()">Try Again</button>
      ${bingBtn}
    </div>
  </div>
</body>
</html>`;
}

function extractBingClickTarget(target: URL): URL | null {
  if (!target.hostname.toLowerCase().endsWith('bing.com') || target.pathname !== '/ck/a') {
    return null;
  }
  const encodedU = target.searchParams.get('u');
  if (!encodedU || encodedU.length < 3 || !encodedU.startsWith('a1')) {
    return null;
  }
  try {
    const b64 = encodedU.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    const resolved = new URL(decoded, 'https://www.bing.com/');
    if ((resolved.protocol === 'http:' || resolved.protocol === 'https:') && !isPrivateOrBlockedHost(resolved.hostname)) {
      return resolved;
    }
  } catch {
    return null;
  }
  return null;
}

function extractJsRedirectTarget(html: string, baseUrl: string): URL | null {
  if (html.length > 8192) return null;
  const match =
    html.match(/var\s+u\s*=\s*["']([^"']+)["'][\s\S]{0,240}window\.location\.(?:replace|href)/i) ||
    html.match(/window\.location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i) ||
    html.match(/window\.location\.href\s*=\s*["']([^"']+)["']/i);
  if (!match) return null;
  const resolved = resolveMaybeUrl(match[1], baseUrl);
  if (!resolved) return null;
  return normalizeTargetUrl(resolved);
}

function resolveJsDelivrFallbackUrls(target: URL): URL[] {
  if (target.hostname.toLowerCase() !== 'cdn.jsdelivr.net') return [];
  const rest = target.pathname.replace(/^\/gh\//, '');
  if (rest === target.pathname) return [];
  const slash1 = rest.indexOf('/');
  if (slash1 === -1) return [];
  const owner = rest.slice(0, slash1);
  const afterOwner = rest.slice(slash1 + 1);
  const slash2 = afterOwner.indexOf('/');
  if (slash2 === -1) return [];
  const repoAndRef = afterOwner.slice(0, slash2);
  const filePath = afterOwner.slice(slash2 + 1) || 'index.html';

  const atIdx = repoAndRef.indexOf('@');
  if (atIdx !== -1) {
    const repo = repoAndRef.slice(0, atIdx);
    const ref = repoAndRef.slice(atIdx + 1) || 'main';
    return [new URL(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`)];
  }
  return [
    new URL(`https://raw.githubusercontent.com/${owner}/${repoAndRef}/main/${filePath}`),
    new URL(`https://raw.githubusercontent.com/${owner}/${repoAndRef}/master/${filePath}`),
  ];
}

function inferContentType(pathname: string, upstreamContentType: string): string {
  const lowerCt = upstreamContentType.toLowerCase();
  if (!lowerCt.startsWith('text/plain') && !lowerCt.startsWith('application/octet-stream')) {
    return lowerCt;
  }
  const cleanPath = pathname.toLowerCase().split('?')[0];
  if (cleanPath.endsWith('.html') || cleanPath.endsWith('.htm')) return 'text/html; charset=utf-8';
  if (cleanPath.endsWith('.js') || cleanPath.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
  if (cleanPath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (cleanPath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (cleanPath.endsWith('.svg')) return 'image/svg+xml';
  if (cleanPath.endsWith('.png')) return 'image/png';
  if (cleanPath.endsWith('.jpg') || cleanPath.endsWith('.jpeg')) return 'image/jpeg';
  if (cleanPath.endsWith('.webp')) return 'image/webp';
  if (cleanPath.endsWith('.gif')) return 'image/gif';
  if (cleanPath.endsWith('.ico')) return 'image/x-icon';
  if (cleanPath.endsWith('.avif')) return 'image/avif';
  if (cleanPath.endsWith('.wasm')) return 'application/wasm';
  if (cleanPath.endsWith('.mp3')) return 'audio/mpeg';
  if (cleanPath.endsWith('.ogg')) return 'audio/ogg';
  if (cleanPath.endsWith('.wav')) return 'audio/wav';
  if (cleanPath.endsWith('.m4a')) return 'audio/mp4';
  if (cleanPath.endsWith('.aac')) return 'audio/aac';
  if (cleanPath.endsWith('.flac')) return 'audio/flac';
  if (cleanPath.endsWith('.mp4')) return 'video/mp4';
  if (cleanPath.endsWith('.webm')) return 'video/webm';
  if (cleanPath.endsWith('.woff2')) return 'font/woff2';
  if (cleanPath.endsWith('.woff')) return 'font/woff';
  if (cleanPath.endsWith('.ttf')) return 'font/ttf';
  if (cleanPath.endsWith('.otf')) return 'font/otf';
  if (cleanPath.endsWith('.eot')) return 'application/vnd.ms-fontobject';
  if (cleanPath.endsWith('.xml')) return 'application/xml; charset=utf-8';
  if (cleanPath.endsWith('.data') || cleanPath.endsWith('.unityweb') || cleanPath.endsWith('.pck') || cleanPath.endsWith('.bin') || cleanPath.endsWith('.mem')) {
    return 'application/octet-stream';
  }
  return lowerCt;
}

interface YoutubeVideoCard {
  videoId: string;
  title: string;
  author: string;
  channelUrl: string;
  views: string;
  duration: string;
  published: string;
  thumbnail: string;
  isShort?: boolean;
}

interface TikTokVideoCard {
  videoId: string;
  url: string;
  title: string;
  author: string;
  authorUrl: string;
  thumbnail: string;
  duration: string;
}

const STREAM_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function isYoutubeHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'youtube.com' ||
    h === 'www.youtube.com' ||
    h === 'm.youtube.com' ||
    h === 'youtu.be' ||
    h === 'youtube-nocookie.com' ||
    h === 'www.youtube-nocookie.com' ||
    h === 'music.youtube.com'
  );
}

function isTikTokHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'tiktok.com' ||
    h === 'www.tiktok.com' ||
    h === 'm.tiktok.com' ||
    h === 'vm.tiktok.com' ||
    h === 'vt.tiktok.com'
  );
}

function isTikTokAssetOrCdnHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    isTikTokHost(h) ||
    h.endsWith('.tiktok.com') ||
    h === 'tiktokcdn.com' ||
    h.endsWith('.tiktokcdn.com') ||
    h === 'tiktokcdn-us.com' ||
    h.endsWith('.tiktokcdn-us.com') ||
    h === 'tiktokv.com' ||
    h.endsWith('.tiktokv.com') ||
    h === 'ttwstatic.com' ||
    h.endsWith('.ttwstatic.com')
  );
}

function extractBalancedJsonAfter(source: string, markerRegex: RegExp): string | null {
  const match = markerRegex.exec(source);
  if (!match) return null;
  let start = source.indexOf('{', match.index + match[0].length - 1);
  if (start === -1) start = source.indexOf('{', match.index);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  return null;
}

function extractScriptJsonById(html: string, id: string): unknown | null {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<script[^>]*id=["']${escapedId}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i');
  const match = re.exec(html);
  if (!match || !match[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function readYtText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  if (typeof obj.simpleText === 'string') return obj.simpleText;
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.runs)) {
    return obj.runs
      .map((r) => (r && typeof r === 'object' && typeof (r as Record<string, unknown>).text === 'string' ? (r as Record<string, unknown>).text : ''))
      .join('');
  }
  return '';
}

function extractYoutubeVideoId(target: URL): string | null {
  const host = target.hostname.toLowerCase();
  const parts = target.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be' && parts[0]) {
    return parts[0].replace(/[^a-zA-Z0-9_-]/g, '') || null;
  }
  if (target.pathname === '/watch') {
    const v = target.searchParams.get('v');
    return v ? v.replace(/[^a-zA-Z0-9_-]/g, '') : null;
  }
  if (parts.length >= 2 && (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live' || parts[0] === 'v')) {
    return parts[1].replace(/[^a-zA-Z0-9_-]/g, '') || null;
  }
  return null;
}

function extractYoutubeVideosFromInitialData(initialData: unknown, limit = 36): YoutubeVideoCard[] {
  const results: YoutubeVideoCard[] = [];
  const seen = new Set<string>();
  const stack: unknown[] = [initialData];

  while (stack.length > 0 && results.length < limit) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object') continue;
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i -= 1) {
        stack.push(cur[i]);
      }
      continue;
    }

    const obj = cur as Record<string, unknown>;
    const vr = (
      obj.videoRenderer ||
      obj.compactVideoRenderer ||
      obj.gridVideoRenderer ||
      obj.playlistVideoRenderer ||
      obj.videoCardRenderer
    ) as Record<string, unknown> | undefined;

    if (vr && typeof vr.videoId === 'string' && !seen.has(vr.videoId)) {
      const videoId = vr.videoId;
      seen.add(videoId);
      const title = readYtText(vr.title) || 'YouTube Video';
      const author =
        readYtText(vr.ownerText) ||
        readYtText(vr.longBylineText) ||
        readYtText(vr.shortBylineText) ||
        readYtText(vr.bylineText) ||
        'YouTube Creator';
      const navBrowse =
        ((vr.ownerText as Record<string, unknown> | undefined)?.runs as Array<Record<string, unknown>> | undefined)?.[0]
          ?.navigationEndpoint ||
        ((vr.shortBylineText as Record<string, unknown> | undefined)?.runs as Array<Record<string, unknown>> | undefined)?.[0]
          ?.navigationEndpoint;
      const browseUrl =
        ((navBrowse as Record<string, unknown> | undefined)?.commandMetadata as Record<string, unknown> | undefined)
          ?.webCommandMetadata as Record<string, unknown> | undefined;
      const channelPath = typeof browseUrl?.url === 'string' ? browseUrl.url : '';
      const views =
        readYtText(vr.shortViewCountText) ||
        readYtText(vr.viewCountText) ||
        readYtText(vr.metadataText) ||
        '';
      const duration = readYtText(vr.lengthText) || '';
      const published = readYtText(vr.publishedTimeText) || '';
      const thumbs = ((vr.thumbnail as Record<string, unknown> | undefined)?.thumbnails as Array<Record<string, unknown>> | undefined) || [];
      const rawThumb =
        (typeof thumbs[thumbs.length - 1]?.url === 'string' ? (thumbs[thumbs.length - 1].url as string) : '') ||
        `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

      results.push({
        videoId,
        title,
        author,
        channelUrl: channelPath ? `https://www.youtube.com${channelPath}` : '',
        views,
        duration,
        published,
        thumbnail: rawThumb.startsWith('//') ? `https:${rawThumb}` : rawThumb,
      });
      continue;
    }

    const reel = obj.reelItemRenderer as Record<string, unknown> | undefined;
    if (reel && typeof reel.videoId === 'string' && !seen.has(reel.videoId)) {
      const videoId = reel.videoId;
      seen.add(videoId);
      const title = readYtText(reel.headline) || 'YouTube Short';
      const views = readYtText(reel.viewCountText) || '';
      results.push({
        videoId,
        title,
        author: 'Shorts',
        channelUrl: '',
        views,
        duration: 'Short',
        published: '',
        thumbnail: `https://i.ytimg.com/vi/${videoId}/frame0.jpg`,
        isShort: true,
      });
      continue;
    }

    const shortsLockup = obj.shortsLockupViewModel as Record<string, unknown> | undefined;
    if (shortsLockup) {
      const reelEp = ((shortsLockup.onTap as Record<string, unknown> | undefined)?.innertubeCommand as Record<string, unknown> | undefined)
        ?.reelWatchEndpoint as Record<string, unknown> | undefined;
      const entityId = typeof shortsLockup.entityId === 'string' ? shortsLockup.entityId : '';
      const rawId =
        (typeof reelEp?.videoId === 'string' && reelEp.videoId) ||
        entityId.replace(/^shorts-shelf-item-/, '');
      const videoId = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
      if (videoId && !seen.has(videoId)) {
        seen.add(videoId);
        const om = shortsLockup.overlayMetadata as Record<string, unknown> | undefined;
        const a11y = typeof shortsLockup.accessibilityText === 'string' ? shortsLockup.accessibilityText : '';
        const primary = readYtText(om?.primaryText);
        const secondary = readYtText(om?.secondaryText);
        const cleanedA11yTitle = a11y
          .replace(/,\s*[^,]+?\s*views\s*-\s*play Short$/i, '')
          .replace(/\s*-\s*play Short$/i, '')
          .trim();
        const a11yViewsMatch = a11y.match(/,\s*([^,]+?\s*views)\s*-\s*play Short$/i);
        const title = primary || cleanedA11yTitle || 'YouTube Short';
        const views = secondary || (a11yViewsMatch ? a11yViewsMatch[1] : '');

        const innerTvm = (shortsLockup.thumbnailViewModel as Record<string, unknown> | undefined)?.thumbnailViewModel as
          | Record<string, unknown>
          | undefined;
        const tvmSources =
          ((innerTvm?.image as Record<string, unknown> | undefined)?.sources as Array<Record<string, unknown>> | undefined) || [];
        const epThumbs =
          ((reelEp?.thumbnail as Record<string, unknown> | undefined)?.thumbnails as Array<Record<string, unknown>> | undefined) || [];
        const rawThumb =
          (typeof tvmSources[tvmSources.length - 1]?.url === 'string'
            ? (tvmSources[tvmSources.length - 1].url as string)
            : '') ||
          (typeof epThumbs[epThumbs.length - 1]?.url === 'string'
            ? (epThumbs[epThumbs.length - 1].url as string)
            : '') ||
          `https://i.ytimg.com/vi/${videoId}/frame0.jpg`;

        results.push({
          videoId,
          title,
          author: 'YouTube Shorts',
          channelUrl: '',
          views,
          duration: 'Short',
          published: '',
          thumbnail: rawThumb.startsWith('//') ? `https:${rawThumb}` : rawThumb,
          isShort: true,
        });
        continue;
      }
    }

    const lockup = obj.lockupViewModel as Record<string, unknown> | undefined;
    if (lockup) {
      const contentType = typeof lockup.contentType === 'string' ? lockup.contentType : '';
      const tvm = (lockup.contentImage as Record<string, unknown> | undefined)?.thumbnailViewModel as
        | Record<string, unknown>
        | undefined;
      const tvmSources = ((tvm?.image as Record<string, unknown> | undefined)?.sources as Array<Record<string, unknown>> | undefined) || [];
      const firstThumbUrl = typeof tvmSources[0]?.url === 'string' ? (tvmSources[0].url as string) : '';
      const thumbVidMatch = firstThumbUrl.match(/\/vi\/([a-zA-Z0-9_-]{11})\//);
      const videoId =
        (typeof lockup.contentId === 'string' && /^[a-zA-Z0-9_-]{11}$/.test(lockup.contentId) ? lockup.contentId : '') ||
        (thumbVidMatch ? thumbVidMatch[1] : '');

      if (videoId && (!contentType || contentType.includes('VIDEO')) && !seen.has(videoId)) {
        seen.add(videoId);
        const meta = (lockup.metadata as Record<string, unknown> | undefined)?.lockupMetadataViewModel as
          | Record<string, unknown>
          | undefined;
        const title = readYtText(meta?.title) || 'YouTube Video';
        const rows =
          (((meta?.metadata as Record<string, unknown> | undefined)?.contentMetadataViewModel as Record<string, unknown> | undefined)
            ?.metadataRows as Array<Record<string, unknown>>) || [];
        const author =
          readYtText((rows[0]?.metadataParts as Array<Record<string, unknown>> | undefined)?.[0]?.text) || 'YouTube';
        const views =
          readYtText((rows[1]?.metadataParts as Array<Record<string, unknown>> | undefined)?.[0]?.text) || '';
        const overlays = (tvm?.overlays as Array<Record<string, unknown>> | undefined) || [];
        const badge =
          ((overlays[0]?.thumbnailBottomOverlayViewModel as Record<string, unknown> | undefined)?.badges as Array<Record<string, unknown>> | undefined)?.[0]
            ?.thumbnailBadgeViewModel as Record<string, unknown> | undefined;
        const duration = typeof badge?.text === 'string' ? badge.text : '';
        results.push({
          videoId,
          title,
          author,
          channelUrl: '',
          views,
          duration,
          published: '',
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        });
        continue;
      }
    }

    for (const val of Object.values(obj)) {
      if (val && typeof val === 'object') {
        stack.push(val);
      }
    }
  }

  return results;
}

function buildMediaFrameBridgeScript(canonicalUrl: string, pageTitle: string): string {
  const safeUrl = JSON.stringify(canonicalUrl);
  const safeTitle = JSON.stringify(pageTitle);
  return `<script>
(function() {
  var CANONICAL_URL = ${safeUrl};
  var PAGE_TITLE = ${safeTitle};
  function notify() {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'unblocker:loaded', url: CANONICAL_URL, title: PAGE_TITLE }, '*');
      }
    } catch (e) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', notify);
  } else {
    notify();
  }
  window.addEventListener('load', notify);
})();
</script>`;
}

function formatCompactCount(raw: string | number | undefined): string {
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return '';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(num);
}

function formatDurationSeconds(raw: string | number | undefined): string {
  const total = Math.floor(Number(raw));
  if (!Number.isFinite(total) || total <= 0) return '';
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function renderYoutubeWatchPage(opts: {
  videoId: string;
  canonicalUrl: string;
  title: string;
  author: string;
  channelUrl: string;
  views: string;
  description: string;
  directStreamUrl: string | null;
  related: YoutubeVideoCard[];
  isShort: boolean;
}): string {
  const pageTitle = `${opts.title || 'YouTube'} - YouTube`;
  const bridge = buildMediaFrameBridgeScript(opts.canonicalUrl, pageTitle);
  const loopQs = opts.isShort ? `&loop=1&playlist=${encodeURIComponent(opts.videoId)}` : '';
  const standardEmbedUrl = `https://www.youtube.com/embed/${encodeURIComponent(opts.videoId)}?autoplay=1&rel=0&playsinline=1${loopQs}`;
  const nocookieUrl = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(opts.videoId)}?autoplay=1&rel=0&playsinline=1${loopQs}`;
  const posterUrl = toProxyUrl(`https://i.ytimg.com/vi/${opts.videoId}/hqdefault.jpg`);
  const directProxyUrl = opts.directStreamUrl ? toProxyUrl(opts.directStreamUrl) : '';

  const relatedFiltered = opts.related.filter((v) => v.videoId !== opts.videoId);
  const nextShortItem = opts.isShort ? relatedFiltered.find((v) => v.isShort) || relatedFiltered[0] : null;
  const nextShortHref = nextShortItem
    ? toProxyUrl(
        nextShortItem.isShort
          ? `https://www.youtube.com/shorts/${encodeURIComponent(nextShortItem.videoId)}`
          : `https://www.youtube.com/watch?v=${encodeURIComponent(nextShortItem.videoId)}`
      )
    : '';

  const relatedHtml = relatedFiltered
    .slice(0, 18)
    .map((v) => {
      const targetPath = v.isShort
        ? `https://www.youtube.com/shorts/${encodeURIComponent(v.videoId)}`
        : `https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`;
      const href = toProxyUrl(targetPath);
      const thumb = toProxyUrl(v.thumbnail);
      return `<a class="upnext-card" href="${escapeHtml(href)}">
        <div class="upnext-thumb">
          <img src="${escapeHtml(thumb)}" alt="" loading="lazy" />
          ${v.duration ? `<span class="dur">${escapeHtml(v.duration)}</span>` : ''}
        </div>
        <div class="upnext-meta">
          <div class="upnext-title">${escapeHtml(v.title)}</div>
          <div class="upnext-sub">${escapeHtml(v.author)}</div>
          ${v.views ? `<div class="upnext-sub">${escapeHtml(v.views)}</div>` : ''}
        </div>
      </a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  ${bridge}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: #0b111b; color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    a { color: inherit; text-decoration: none; }
    .yt-top { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 18px; background: rgba(11, 17, 27, 0.96); border-bottom: 1px solid #1e293b; backdrop-filter: blur(10px); }
    .yt-brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; font-size: 17px; letter-spacing: -0.02em; color: #fff; }
    .yt-badge { display: inline-grid; place-items: center; width: 30px; height: 21px; border-radius: 6px; background: #ef4444; color: #fff; font-size: 11px; font-weight: 800; }
    .yt-search { flex: 1; min-width: 220px; max-width: 560px; display: flex; gap: 8px; }
    .yt-search input { flex: 1; background: #0f172a; border: 1px solid #334155; color: #f8fafc; padding: 9px 14px; border-radius: 999px; font-size: 14px; outline: none; }
    .yt-search input:focus { border-color: #0bc2cf; }
    .yt-search button, .yt-pill { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .yt-search button:hover, .yt-pill:hover { background: #334155; }
    .yt-pill.is-short-pill { border-color: #ef4444; color: #fecaca; }
    .yt-nav { display: flex; gap: 8px; flex-wrap: wrap; }
    .yt-layout { max-width: 1420px; margin: 0 auto; padding: 18px; display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 22px; }
    @media (max-width: 980px) { .yt-layout { grid-template-columns: 1fr; } }
    .player-stage { width: 100%; background: #000; border-radius: 14px; overflow: hidden; border: 1px solid #1e293b; aspect-ratio: ${opts.isShort ? '9 / 16' : '16 / 9'}; ${opts.isShort ? 'max-height: 76vh; margin: 0 auto; max-width: 440px;' : ''} }
    .player-stage video, .player-stage iframe { width: 100%; height: 100%; display: block; border: 0; background: #000; }
    .mode-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
    .mode-btns { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .mode-btn { display: inline-flex; align-items: center; gap: 5px; background: #162235; border: 1px solid #29384f; color: #cbd5e1; padding: 7px 13px; border-radius: 9px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .mode-btn:hover { background: #1e2d44; }
    .mode-btn.is-active { background: #0bc2cf; color: #042f2e; border-color: #0bc2cf; }
    .mode-btn.next-short { background: #ef4444; border-color: #ef4444; color: #fff; }
    .mode-btn.popout-link { border-color: #334155; color: #e2e8f0; }
    .embed-note { margin-top: 8px; font-size: 12px; color: #94a3b8; }
    .video-meta { margin-top: 14px; background: #111a29; border: 1px solid #1e293b; border-radius: 14px; padding: 16px 18px; }
    .video-meta h1 { margin: 0 0 10px; font-size: 20px; line-height: 1.35; font-weight: 700; }
    .video-subrow { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; font-size: 13px; color: #94a3b8; }
    .channel-chip { background: #1e293b; color: #f8fafc; padding: 6px 12px; border-radius: 999px; font-weight: 600; font-size: 13px; }
    .channel-chip:hover { background: #334155; }
    .video-desc { margin-top: 12px; font-size: 13px; line-height: 1.6; color: #cbd5e1; white-space: pre-wrap; max-height: 170px; overflow-y: auto; border-top: 1px solid #1e293b; padding-top: 12px; }
    .upnext-heading { margin: 0 0 12px; font-size: 15px; font-weight: 700; color: #e2e8f0; }
    .upnext-list { display: flex; flex-direction: column; gap: 10px; }
    .upnext-card { display: grid; grid-template-columns: 152px 1fr; gap: 10px; padding: 6px; border-radius: 10px; transition: background 0.15s; }
    .upnext-card:hover { background: #162235; }
    .upnext-thumb { position: relative; aspect-ratio: 16 / 9; border-radius: 8px; overflow: hidden; background: #1e293b; }
    .upnext-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .dur { position: absolute; right: 5px; bottom: 5px; background: rgba(0, 0, 0, 0.82); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 5px; border-radius: 4px; }
    .upnext-title { font-size: 13px; font-weight: 600; line-height: 1.35; color: #f1f5f9; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .upnext-sub { font-size: 12px; color: #94a3b8; margin-top: 3px; }
  </style>
</head>
<body>
  <header class="yt-top">
    <a class="yt-brand" href="${escapeHtml(toProxyUrl('https://www.youtube.com/'))}">
      <span class="yt-badge">&#9654;</span>
      <span>YouTube</span>
    </a>
    <form id="yt-search-form" class="yt-search">
      <input id="yt-search-input" type="search" placeholder="Search YouTube without signing in..." required />
      <button type="submit">Search</button>
    </form>
    <nav class="yt-nav">
      <a class="yt-pill" href="${escapeHtml(toProxyUrl('https://www.youtube.com/'))}">Home</a>
      <a class="yt-pill is-short-pill" href="${escapeHtml(toProxyUrl('https://www.youtube.com/shorts'))}">Shorts</a>
      <a class="yt-pill" href="${escapeHtml(toProxyUrl('https://www.youtube.com/gaming'))}">Gaming</a>
      <a class="yt-pill" href="${escapeHtml(toProxyUrl('https://www.youtube.com/music'))}">Music</a>
    </nav>
  </header>

  <main class="yt-layout">
    <section>
      <div id="player-stage" class="player-stage"></div>
      <div class="mode-bar">
        <div class="mode-btns">
          ${directProxyUrl ? '<button type="button" class="mode-btn" data-mode="direct">Direct Video Stream</button>' : ''}
          <button type="button" class="mode-btn" data-mode="standard">Standard Player (HD)</button>
          <button type="button" class="mode-btn" data-mode="nocookie">Privacy Embed</button>
          <a class="mode-btn popout-link" href="${escapeHtml(standardEmbedUrl)}" target="_blank" rel="noopener noreferrer">Open Top-Level Player &nearr;</a>
        </div>
        ${nextShortHref ? `<a class="mode-btn next-short" href="${escapeHtml(nextShortHref)}">Next Short &rarr;</a>` : ''}
      </div>
      ${
        directProxyUrl
          ? ''
          : '<div class="embed-note">If your browser blocks embedded cookies inside this frame, use <strong>Open Top-Level Player &nearr;</strong> to play without signing in.</div>'
      }
      <div class="video-meta">
        <h1>${escapeHtml(opts.title || 'YouTube Video')}</h1>
        <div class="video-subrow">
          ${
            opts.channelUrl
              ? `<a class="channel-chip" href="${escapeHtml(toProxyUrl(opts.channelUrl))}">${escapeHtml(opts.author || 'Creator')}</a>`
              : `<span class="channel-chip">${escapeHtml(opts.author || 'Creator')}</span>`
          }
          ${opts.views ? `<span>${escapeHtml(opts.views)}</span>` : ''}
        </div>
        ${opts.description ? `<div class="video-desc">${escapeHtml(opts.description)}</div>` : ''}
      </div>
    </section>
    <aside>
      <h2 class="upnext-heading">${opts.isShort ? 'More Shorts' : 'Up Next'}</h2>
      <div class="upnext-list">${relatedHtml || '<div style="color:#94a3b8;font-size:13px;">Search above to discover more videos.</div>'}</div>
    </aside>
  </main>

  <script>
    (function() {
      var DIRECT_URL = ${JSON.stringify(directProxyUrl)};
      var STANDARD_URL = ${JSON.stringify(standardEmbedUrl)};
      var NOCOOKIE_URL = ${JSON.stringify(nocookieUrl)};
      var POSTER_URL = ${JSON.stringify(posterUrl)};
      var IS_SHORT = ${JSON.stringify(opts.isShort)};
      var NEXT_SHORT_HREF = ${JSON.stringify(nextShortHref)};
      var stage = document.getElementById('player-stage');
      var buttons = Array.prototype.slice.call(document.querySelectorAll('.mode-btn[data-mode]'));

      function setActiveBtn(mode) {
        buttons.forEach(function(b) {
          b.classList.toggle('is-active', b.getAttribute('data-mode') === mode);
        });
      }

      function mountMode(mode) {
        stage.innerHTML = '';
        setActiveBtn(mode);
        if (mode === 'direct' && DIRECT_URL) {
          var v = document.createElement('video');
          v.controls = true;
          v.autoplay = true;
          v.loop = IS_SHORT;
          v.playsInline = true;
          v.poster = POSTER_URL;
          v.src = DIRECT_URL;
          v.addEventListener('error', function() {
            mountMode('standard');
          }, { once: true });
          stage.appendChild(v);
          return;
        }
        var f = document.createElement('iframe');
        f.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen';
        f.allowFullscreen = true;
        f.referrerPolicy = 'strict-origin-when-cross-origin';
        f.src = mode === 'nocookie' ? NOCOOKIE_URL : STANDARD_URL;
        stage.appendChild(f);
      }

      buttons.forEach(function(b) {
        b.addEventListener('click', function() {
          mountMode(b.getAttribute('data-mode'));
        });
      });

      mountMode(DIRECT_URL ? 'direct' : 'standard');

      if (IS_SHORT && NEXT_SHORT_HREF) {
        document.addEventListener('keydown', function(ev) {
          if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
          if (ev.key === 'ArrowDown') {
            window.location.href = NEXT_SHORT_HREF;
          }
        });
      }

      var sf = document.getElementById('yt-search-form');
      var si = document.getElementById('yt-search-input');
      if (sf && si) {
        sf.addEventListener('submit', function(ev) {
          ev.preventDefault();
          var q = si.value.trim();
          if (!q) return;
          window.location.href = '/api/proxy?url=' + encodeURIComponent('https://www.youtube.com/results?search_query=' + encodeURIComponent(q));
        });
      }
    })();
  </script>
</body>
</html>`;
}

function renderYoutubeBrowsePage(opts: {
  canonicalUrl: string;
  heading: string;
  searchQuery: string;
  videos: YoutubeVideoCard[];
  isShortsFeed?: boolean;
}): string {
  const pageTitle = opts.searchQuery ? `${opts.searchQuery} - YouTube` : `${opts.heading} - YouTube`;
  const bridge = buildMediaFrameBridgeScript(opts.canonicalUrl, pageTitle);
  const cardsHtml = opts.videos
    .map((v) => {
      const watchTarget = v.isShort
        ? `https://www.youtube.com/shorts/${encodeURIComponent(v.videoId)}`
        : `https://www.youtube.com/watch?v=${encodeURIComponent(v.videoId)}`;
      const watchHref = toProxyUrl(watchTarget);
      const thumb = toProxyUrl(v.thumbnail);
      const thumbClass = opts.isShortsFeed || v.isShort ? 'yt-card-thumb is-short-thumb' : 'yt-card-thumb';
      return `<a class="yt-card${opts.isShortsFeed ? ' is-short-card' : ''}" href="${escapeHtml(watchHref)}">
        <div class="${thumbClass}">
          <img src="${escapeHtml(thumb)}" alt="" loading="lazy" />
          ${v.duration ? `<span class="dur${v.isShort ? ' dur-short' : ''}">${escapeHtml(v.duration)}</span>` : ''}
        </div>
        <div class="yt-card-body">
          <div class="yt-card-title">${escapeHtml(v.title)}</div>
          <div class="yt-card-sub">${escapeHtml(v.author)}</div>
          ${v.views || v.published ? `<div class="yt-card-sub">${escapeHtml([v.views, v.published].filter(Boolean).join(' · '))}</div>` : ''}
        </div>
      </a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  ${bridge}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: #0b111b; color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    a { color: inherit; text-decoration: none; }
    .yt-top { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 18px; background: rgba(11, 17, 27, 0.96); border-bottom: 1px solid #1e293b; backdrop-filter: blur(10px); }
    .yt-brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; font-size: 17px; color: #fff; }
    .yt-badge { display: inline-grid; place-items: center; width: 30px; height: 21px; border-radius: 6px; background: #ef4444; color: #fff; font-size: 11px; font-weight: 800; }
    .yt-search { flex: 1; min-width: 220px; max-width: 560px; display: flex; gap: 8px; }
    .yt-search input { flex: 1; background: #0f172a; border: 1px solid #334155; color: #f8fafc; padding: 9px 14px; border-radius: 999px; font-size: 14px; outline: none; }
    .yt-search input:focus { border-color: #0bc2cf; }
    .yt-search button, .yt-pill { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .yt-search button:hover, .yt-pill:hover { background: #334155; }
    .yt-pill.is-short-pill { border-color: #ef4444; color: #fecaca; }
    .yt-nav { display: flex; gap: 8px; flex-wrap: wrap; }
    .yt-wrap { max-width: 1380px; margin: 0 auto; padding: 20px 18px 40px; }
    .yt-h1 { margin: 0 0 18px; font-size: 21px; font-weight: 700; }
    .yt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(${opts.isShortsFeed ? '205px' : '265px'}, 1fr)); gap: 18px; }
    .yt-card { display: flex; flex-direction: column; border-radius: 12px; background: #111a29; border: 1px solid #1e293b; overflow: hidden; transition: transform 0.14s, border-color 0.14s; }
    .yt-card:hover { transform: translateY(-2px); border-color: #0bc2cf; }
    .yt-card.is-short-card:hover { border-color: #ef4444; }
    .yt-card-thumb { position: relative; aspect-ratio: 16 / 9; background: #1e293b; }
    .yt-card-thumb.is-short-thumb { aspect-ratio: 9 / 15; }
    .yt-card-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .dur { position: absolute; right: 7px; bottom: 7px; background: rgba(0, 0, 0, 0.85); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
    .dur.dur-short { background: #ef4444; }
    .yt-card-body { padding: 12px 14px; }
    .yt-card-title { font-size: 14px; font-weight: 600; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 6px; }
    .yt-card-sub { font-size: 12px; color: #94a3b8; margin-top: 2px; }
  </style>
</head>
<body>
  <header class="yt-top">
    <a class="yt-brand" href="${escapeHtml(toProxyUrl('https://www.youtube.com/'))}">
      <span class="yt-badge">&#9654;</span>
      <span>YouTube</span>
    </a>
    <form id="yt-search-form" class="yt-search">
      <input id="yt-search-input" type="search" value="${escapeHtml(opts.searchQuery)}" placeholder="Search any video or creator..." required />
      <button type="submit">Search</button>
    </form>
    <nav class="yt-nav">
      <a class="yt-pill" href="${escapeHtml(toProxyUrl('https://www.youtube.com/'))}">Home</a>
      <a class="yt-pill is-short-pill" href="${escapeHtml(toProxyUrl('https://www.youtube.com/shorts'))}">Shorts</a>
      <a class="yt-pill" href="${escapeHtml(toProxyUrl('https://www.youtube.com/gaming'))}">Gaming</a>
      <a class="yt-pill" href="${escapeHtml(toProxyUrl('https://www.youtube.com/music'))}">Music</a>
      <a class="yt-pill" href="${escapeHtml(toProxyUrl('https://www.youtube.com/results?search_query=sports+highlights'))}">Sports</a>
    </nav>
  </header>

  <main class="yt-wrap">
    <h1 class="yt-h1">${escapeHtml(opts.heading)}</h1>
    ${
      cardsHtml
        ? `<div class="yt-grid">${cardsHtml}</div>`
        : '<p style="color:#94a3b8;">No videos found for this page. Try searching above.</p>'
    }
  </main>

  <script>
    (function() {
      var sf = document.getElementById('yt-search-form');
      var si = document.getElementById('yt-search-input');
      if (sf && si) {
        sf.addEventListener('submit', function(ev) {
          ev.preventDefault();
          var q = si.value.trim();
          if (!q) return;
          window.location.href = '/api/proxy?url=' + encodeURIComponent('https://www.youtube.com/results?search_query=' + encodeURIComponent(q));
        });
      }
    })();
  </script>
</body>
</html>`;
}

async function handleYoutubeProxyRequest(target: URL, sid: string, res: Response): Promise<boolean> {
  if (target.searchParams.get('yamal_raw') === '1') {
    return false;
  }

  const videoId = extractYoutubeVideoId(target);
  if (videoId) {
    const canonicalWatch = `https://www.youtube.com/watch?v=${videoId}`;
    const isShort = target.pathname.startsWith('/shorts/');
    const watchFetchPromise = fetch(canonicalWatch, {
      headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(12000),
    }).then(async (r) => {
      const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
      if (setCookies.length > 0) {
        storeUpstreamCookies(sid, new URL(canonicalWatch), setCookies);
      }
      const html = await r.text();
      return { html, cookies: setCookies.map((c) => c.split(';')[0]).join('; ') };
    });

    let watchHtml = '';
    let watchCookies = '';
    try {
      const w = await watchFetchPromise;
      watchHtml = w.html;
      watchCookies = w.cookies;
    } catch {
      watchHtml = '';
    }

    const visitorData = watchHtml.match(/"visitorData":"([^"]+)"/)?.[1] || '';
    const initialPrRaw = watchHtml ? extractBalancedJsonAfter(watchHtml, /var\s+ytInitialPlayerResponse\s*=/) : null;
    const initialDataRaw = watchHtml ? extractBalancedJsonAfter(watchHtml, /var\s+ytInitialData\s*=/) : null;

    let initialPr: Record<string, unknown> | null = null;
    let initialData: unknown = null;
    try {
      if (initialPrRaw) initialPr = JSON.parse(initialPrRaw) as Record<string, unknown>;
    } catch {
      initialPr = null;
    }
    try {
      if (initialDataRaw) initialData = JSON.parse(initialDataRaw);
    } catch {
      initialData = null;
    }

    let directStreamUrl: string | null = null;
    if ((initialPr?.playabilityStatus as Record<string, unknown> | undefined)?.status === 'OK') {
      const initFormats =
        ((initialPr?.streamingData as Record<string, unknown> | undefined)?.formats as Array<Record<string, unknown>> | undefined) || [];
      const initBest =
        initFormats.find((f) => typeof f.url === 'string' && f.itag === 22) ||
        initFormats.find((f) => typeof f.url === 'string' && f.itag === 18) ||
        initFormats.find((f) => typeof f.url === 'string');
      if (initBest && typeof initBest.url === 'string') {
        directStreamUrl = initBest.url;
      }
    }

    let vrPlayer: Record<string, unknown> | null = null;
    try {
      const vrRes = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          ...(visitorData ? { 'x-goog-visitor-id': visitorData } : {}),
          ...(watchCookies ? { Cookie: watchCookies } : {}),
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: 'ANDROID_VR',
              clientVersion: '1.56.21',
              deviceMake: 'Oculus',
              deviceModel: 'Quest 3',
              osName: 'Android',
              osVersion: '12L',
              hl: 'en',
              gl: 'US',
              ...(visitorData ? { visitorData } : {}),
            },
          },
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (vrRes.ok) {
        vrPlayer = (await vrRes.json()) as Record<string, unknown>;
        const playStatus = (vrPlayer.playabilityStatus as Record<string, unknown> | undefined)?.status;
        if (playStatus === 'OK') {
          const formats =
            ((vrPlayer.streamingData as Record<string, unknown> | undefined)?.formats as Array<Record<string, unknown>> | undefined) || [];
          const best =
            formats.find((f) => typeof f.url === 'string' && f.itag === 22) ||
            formats.find((f) => typeof f.url === 'string' && f.itag === 18) ||
            formats.find((f) => typeof f.url === 'string');
          if (best && typeof best.url === 'string') {
            directStreamUrl = best.url;
          }
        }
      }
    } catch {
      // Fall back to initialPr direct stream or embed
    }

    const details =
      (vrPlayer?.videoDetails as Record<string, unknown> | undefined) ||
      (initialPr?.videoDetails as Record<string, unknown> | undefined) ||
      {};
    let title = typeof details.title === 'string' ? details.title : '';
    let author = typeof details.author === 'string' ? details.author : '';
    const channelId = typeof details.channelId === 'string' ? details.channelId : '';
    const viewCountRaw = typeof details.viewCount === 'string' ? details.viewCount : '';
    const views = viewCountRaw ? `${Number(viewCountRaw).toLocaleString()} views` : '';
    const description = typeof details.shortDescription === 'string' ? details.shortDescription : '';

    if (!title) {
      try {
        const oe = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalWatch)}&format=json`, {
          signal: AbortSignal.timeout(5000),
        });
        if (oe.ok) {
          const oj = (await oe.json()) as { title?: string; author_name?: string };
          if (oj.title) title = oj.title;
          if (!author && oj.author_name) author = oj.author_name;
        }
      } catch {
        // Keep defaults
      }
    }

    let related = initialData ? extractYoutubeVideosFromInitialData(initialData, 24) : [];
    if (isShort && related.filter((v) => v.isShort).length < 4) {
      try {
        const sHtml = await (
          await fetch('https://www.youtube.com/results?search_query=%23shorts', {
            headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' },
            signal: AbortSignal.timeout(8000),
          })
        ).text();
        const sRaw = extractBalancedJsonAfter(sHtml, /var\s+ytInitialData\s*=/);
        if (sRaw) {
          const extraShorts = extractYoutubeVideosFromInitialData(JSON.parse(sRaw), 24).filter((v) => v.isShort);
          const seenRel = new Set(related.map((v) => v.videoId));
          related = [...extraShorts.filter((v) => !seenRel.has(v.videoId)), ...related];
        }
      } catch {
        // Keep existing related list
      }
    }

    const html = renderYoutubeWatchPage({
      videoId,
      canonicalUrl: target.toString(),
      title: title || 'YouTube Video',
      author: author || 'YouTube',
      channelUrl: channelId ? `https://www.youtube.com/channel/${channelId}` : '',
      views,
      description,
      directStreamUrl,
      related,
      isShort,
    });

    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    return true;
  }

  // Browse / Search / Channel / Shorts / Home pages
  let fetchUrl = target.toString();
  let heading = 'YouTube';
  let isShortsFeed = false;
  const searchQuery = target.searchParams.get('search_query') || target.searchParams.get('q') || '';
  const pathLower = target.pathname.toLowerCase();

  if (searchQuery) {
    fetchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`;
    heading = `Search: ${searchQuery}`;
  } else if (pathLower === '/shorts' || pathLower === '/shorts/') {
    heading = 'YouTube Shorts';
    isShortsFeed = true;
    const [shortsRes, gamingRes] = await Promise.allSettled([
      fetch('https://www.youtube.com/results?search_query=%23shorts+viral', {
        headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.text()),
      fetch('https://www.youtube.com/gaming', {
        headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(10000),
      }).then((r) => r.text()),
    ]);
    const shortsList: YoutubeVideoCard[] = [];
    const seenIds = new Set<string>();
    for (const settled of [shortsRes, gamingRes]) {
      if (settled.status !== 'fulfilled') continue;
      const raw = extractBalancedJsonAfter(settled.value, /var\s+ytInitialData\s*=/);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        for (const v of extractYoutubeVideosFromInitialData(parsed, 50)) {
          if (v.isShort && !seenIds.has(v.videoId)) {
            seenIds.add(v.videoId);
            shortsList.push(v);
          }
        }
      } catch {
        // Ignore parse error
      }
    }
    const html = renderYoutubeBrowsePage({
      canonicalUrl: target.toString(),
      heading,
      searchQuery: '',
      videos: shortsList.slice(0, 40),
      isShortsFeed: true,
    });
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    return true;
  } else if (pathLower === '/' || pathLower === '/feed/trending' || pathLower === '/feed/explore') {
    heading = 'Trending & Featured';
    const [gamingRes, musicRes] = await Promise.allSettled([
      fetch('https://www.youtube.com/gaming', { headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(10000) }).then((r) => r.text()),
      fetch('https://www.youtube.com/music', { headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(10000) }).then((r) => r.text()),
    ]);
    const combined: YoutubeVideoCard[] = [];
    const seenIds = new Set<string>();
    for (const settled of [gamingRes, musicRes]) {
      if (settled.status !== 'fulfilled') continue;
      const raw = extractBalancedJsonAfter(settled.value, /var\s+ytInitialData\s*=/);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        for (const v of extractYoutubeVideosFromInitialData(parsed, 24)) {
          if (!seenIds.has(v.videoId)) {
            seenIds.add(v.videoId);
            combined.push(v);
          }
        }
      } catch {
        // Ignore parse error
      }
    }
    const html = renderYoutubeBrowsePage({
      canonicalUrl: target.toString(),
      heading,
      searchQuery: '',
      videos: combined.slice(0, 40),
    });
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    return true;
  } else if (
    (pathLower.startsWith('/@') || pathLower.startsWith('/channel/') || pathLower.startsWith('/c/') || pathLower.startsWith('/user/')) &&
    !pathLower.endsWith('/videos') &&
    !pathLower.endsWith('/shorts')
  ) {
    fetchUrl = `${target.origin}${target.pathname.replace(/\/$/, '')}/videos`;
    heading = decodeURIComponent(target.pathname.replace(/^\//, ''));
  } else if (pathLower.endsWith('/shorts')) {
    isShortsFeed = true;
    heading = `${decodeURIComponent(target.pathname.replace(/^\//, '').replace(/\/shorts$/i, ''))} · Shorts`;
  } else if (pathLower === '/gaming') {
    heading = 'Gaming';
  } else if (pathLower === '/music') {
    heading = 'Music';
  }

  let videos: YoutubeVideoCard[] = [];
  try {
    const pageRes = await fetch(fetchUrl, {
      headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(12000),
    });
    const htmlText = await pageRes.text();
    const raw = extractBalancedJsonAfter(htmlText, /var\s+ytInitialData\s*=/);
    if (raw) {
      videos = extractYoutubeVideosFromInitialData(JSON.parse(raw), 40);
    }
  } catch {
    videos = [];
  }

  const outHtml = renderYoutubeBrowsePage({
    canonicalUrl: target.toString(),
    heading,
    searchQuery,
    videos,
    isShortsFeed,
  });
  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(outHtml);
  return true;
}

function extractTikTokVideoId(target: URL): string | null {
  const m =
    target.pathname.match(/\/video\/(\d+)/i) ||
    target.pathname.match(/\/v\/(\d+)/i) ||
    target.pathname.match(/\/embed\/v\d\/(\d+)/i) ||
    target.pathname.match(/\/player\/v\d\/(\d+)/i);
  return m ? m[1] : null;
}

async function fetchTikTokVideosFromBing(query: string, limit = 24): Promise<TikTokVideoCard[]> {
  try {
    const bingUrl = `https://www.bing.com/videos/search?q=${encodeURIComponent(`site:tiktok.com ${query}`.trim())}`;
    const r = await fetch(bingUrl, {
      headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) return [];
    const html = await r.text();
    const cards: TikTokVideoCard[] = [];
    const seen = new Set<string>();
    const matches = html.matchAll(/vrhm="([^"]+)"/g);
    for (const m of matches) {
      if (cards.length >= limit) break;
      try {
        const decoded = decodeHtmlEntities(m[1]).replace(/&#(\d+);/g, (_x, n) => String.fromCharCode(Number(n)));
        const meta = JSON.parse(decoded) as Record<string, unknown>;
        const videoUrl = typeof meta.murl === 'string' ? meta.murl : typeof meta.pgurl === 'string' ? meta.pgurl : '';
        if (!videoUrl) continue;
        const vidMatch = videoUrl.match(/tiktok\.com\/@([^/]+)\/video\/(\d+)/i);
        if (!vidMatch) continue;
        const author = vidMatch[1];
        const videoId = vidMatch[2];
        if (seen.has(videoId)) continue;
        seen.add(videoId);
        const thid = typeof meta.thid === 'string' ? meta.thid : '';
        const smturl = typeof meta.smturl === 'string' ? meta.smturl : '';
        const thumb = thid ? `https://tse2.mm.bing.net/th?id=${encodeURIComponent(thid)}` : smturl;
        cards.push({
          videoId,
          url: `https://www.tiktok.com/@${author}/video/${videoId}`,
          title: typeof meta.vt === 'string' && meta.vt.trim() ? meta.vt.trim() : `TikTok by @${author}`,
          author,
          authorUrl: `https://www.tiktok.com/@${author}`,
          thumbnail: thumb,
          duration: typeof meta.du === 'string' ? meta.du : '',
        });
      } catch {
        // Skip malformed entry
      }
    }
    return cards;
  } catch {
    return [];
  }
}

interface ResolvedTikTokDetail {
  videoId: string;
  canonicalUrl: string;
  playUrl: string;
  coverUrl: string;
  desc: string;
  authorHandle: string;
  authorName: string;
  authorAvatar: string;
  musicTitle: string;
  likes: string;
  comments: string;
  shares: string;
  views: string;
}

async function resolveTikTokVideoDetail(videoUrl: string, sid: string): Promise<ResolvedTikTokDetail | null> {
  let finalUrl = videoUrl;
  let playUrl = '';
  let coverUrl = '';
  let desc = '';
  let authorHandle = '';
  let authorName = '';
  let authorAvatar = '';
  let musicTitle = '';
  let likes = '';
  let comments = '';
  let shares = '';
  let views = '';
  let videoId = '';

  try {
    const res = await fetch(videoUrl, {
      headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    finalUrl = res.url || videoUrl;
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      storeUpstreamCookies(sid, new URL(finalUrl), setCookies);
    }
    const html = await res.text();
    const universal = extractScriptJsonById(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__') as Record<string, unknown> | null;
    const scope = (universal?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined) || {};
    const detail = scope['webapp.video-detail'] as Record<string, unknown> | undefined;
    const item = (detail?.itemInfo as Record<string, unknown> | undefined)?.itemStruct as Record<string, unknown> | undefined;

    if (item) {
      videoId = typeof item.id === 'string' ? item.id : '';
      desc = typeof item.desc === 'string' ? item.desc : '';
      const vObj = (item.video as Record<string, unknown> | undefined) || {};
      const playStruct = (vObj.PlayAddrStruct as Record<string, unknown> | undefined) || {};
      const bitrateList = Array.isArray(vObj.bitrateInfo) ? (vObj.bitrateInfo as Array<Record<string, unknown>>) : [];
      const firstBitrateUrl =
        ((bitrateList[0]?.PlayAddr as Record<string, unknown> | undefined)?.UrlList as string[] | undefined)?.[0] || '';
      const structUrl = (playStruct.UrlList as string[] | undefined)?.[0] || '';
      playUrl =
        (typeof vObj.playAddr === 'string' && vObj.playAddr) ||
        structUrl ||
        firstBitrateUrl ||
        (typeof vObj.downloadAddr === 'string' ? vObj.downloadAddr : '');
      coverUrl =
        (typeof vObj.cover === 'string' && vObj.cover) ||
        (typeof vObj.originCover === 'string' ? vObj.originCover : '');

      const aObj = (item.author as Record<string, unknown> | undefined) || {};
      authorHandle = typeof aObj.uniqueId === 'string' ? aObj.uniqueId : '';
      authorName = typeof aObj.nickname === 'string' ? aObj.nickname : authorHandle;
      authorAvatar = typeof aObj.avatarThumb === 'string' ? aObj.avatarThumb : '';

      const mObj = (item.music as Record<string, unknown> | undefined) || {};
      musicTitle = typeof mObj.title === 'string' ? mObj.title : '';

      const stats = (item.stats as Record<string, unknown> | undefined) || {};
      likes = formatCompactCount(stats.diggCount as number | string | undefined);
      comments = formatCompactCount(stats.commentCount as number | string | undefined);
      shares = formatCompactCount(stats.shareCount as number | string | undefined);
      views = formatCompactCount(stats.playCount as number | string | undefined);
    }
  } catch {
    // Fall through to tikwm fallback
  }

  if (!playUrl) {
    try {
      const apiRes = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(finalUrl)}`, {
        headers: { 'User-Agent': STREAM_UA },
        signal: AbortSignal.timeout(9000),
      });
      if (apiRes.ok) {
        const json = (await apiRes.json()) as { code?: number; data?: Record<string, unknown> };
        const d = json.data;
        if (json.code === 0 && d) {
          videoId = videoId || (typeof d.id === 'string' ? d.id : '');
          playUrl = (typeof d.play === 'string' && d.play) || (typeof d.wmplay === 'string' ? d.wmplay : '');
          coverUrl = coverUrl || (typeof d.cover === 'string' ? d.cover : '');
          desc = desc || (typeof d.title === 'string' ? d.title : '');
          const a = (d.author as Record<string, unknown> | undefined) || {};
          authorHandle = authorHandle || (typeof a.unique_id === 'string' ? a.unique_id : '');
          authorName = authorName || (typeof a.nickname === 'string' ? a.nickname : authorHandle);
          authorAvatar = authorAvatar || (typeof a.avatar === 'string' ? a.avatar : '');
          const m = (d.music_info as Record<string, unknown> | undefined) || {};
          musicTitle = musicTitle || (typeof m.title === 'string' ? m.title : '');
          likes = likes || formatCompactCount(d.digg_count as number | undefined);
          comments = comments || formatCompactCount(d.comment_count as number | undefined);
          shares = shares || formatCompactCount(d.share_count as number | undefined);
          views = views || formatCompactCount(d.play_count as number | undefined);
        }
      }
    } catch {
      // Ignore fallback error
    }
  }

  const parsedFinal = normalizeTargetUrl(finalUrl);
  if (!videoId && parsedFinal) {
    videoId = extractTikTokVideoId(parsedFinal) || '';
  }
  if (!videoId && !playUrl) return null;

  return {
    videoId,
    canonicalUrl:
      authorHandle && videoId ? `https://www.tiktok.com/@${authorHandle}/video/${videoId}` : finalUrl,
    playUrl,
    coverUrl,
    desc,
    authorHandle: authorHandle || 'tiktok',
    authorName: authorName || authorHandle || 'TikTok Creator',
    authorAvatar,
    musicTitle,
    likes,
    comments,
    shares,
    views,
  };
}

function renderTikTokWatchPage(detail: ResolvedTikTokDetail, related: TikTokVideoCard[]): string {
  const titleText = detail.desc ? `${detail.desc.slice(0, 60)} (@${detail.authorHandle}) - TikTok` : `@${detail.authorHandle} - TikTok`;
  const bridge = buildMediaFrameBridgeScript(detail.canonicalUrl, titleText);
  const proxiedPlay = detail.playUrl ? toProxyUrl(detail.playUrl) : '';
  const proxiedPoster = detail.coverUrl ? toProxyUrl(detail.coverUrl) : '';
  const proxiedEmbed = detail.videoId
    ? toProxyUrl(`https://www.tiktok.com/player/v1/${encodeURIComponent(detail.videoId)}?yamal_raw=1`)
    : '';
  const filteredRelated = related.filter((v) => v.videoId !== detail.videoId);
  const nextItem = filteredRelated[0] || null;
  const nextHref = nextItem ? toProxyUrl(nextItem.url) : '';

  const relatedHtml = filteredRelated
    .slice(0, 14)
    .map((v) => {
      const href = toProxyUrl(v.url);
      const thumb = v.thumbnail ? toProxyUrl(v.thumbnail) : '';
      return `<a class="tt-rel-card" href="${escapeHtml(href)}">
        <div class="tt-rel-thumb">
          ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : ''}
          ${v.duration ? `<span class="dur">${escapeHtml(v.duration)}</span>` : ''}
        </div>
        <div class="tt-rel-meta">
          <div class="tt-rel-title">${escapeHtml(v.title)}</div>
          <div class="tt-rel-sub">@${escapeHtml(v.author)}</div>
        </div>
      </a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(titleText)}</title>
  ${bridge}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: #0a0c12; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    a { color: inherit; text-decoration: none; }
    .tt-top { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 18px; background: rgba(10, 12, 18, 0.96); border-bottom: 1px solid #1e2433; backdrop-filter: blur(10px); }
    .tt-brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; font-size: 18px; }
    .tt-mark { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #25f4ee, #fe2c55); color: #05070c; font-weight: 900; font-size: 14px; }
    .tt-search { flex: 1; min-width: 200px; max-width: 500px; display: flex; gap: 8px; }
    .tt-search input { flex: 1; background: #131824; border: 1px solid #283044; color: #fff; padding: 9px 14px; border-radius: 999px; font-size: 14px; outline: none; }
    .tt-search input:focus { border-color: #fe2c55; }
    .tt-search button, .tt-pill { background: #171d2b; border: 1px solid #2b344a; color: #e2e8f0; padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .tt-search button:hover, .tt-pill:hover { background: #263046; }
    .tt-nav { display: flex; gap: 8px; flex-wrap: wrap; }
    .tt-stage { max-width: 1240px; margin: 0 auto; padding: 20px 18px 40px; display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 24px; align-items: start; }
    @media (max-width: 940px) { .tt-stage { grid-template-columns: 1fr; } }
    .tt-theater { display: flex; flex-direction: column; align-items: center; }
    .tt-player-box { width: 100%; max-width: 430px; aspect-ratio: 9 / 16; max-height: 76vh; background: #000; border-radius: 18px; overflow: hidden; border: 1px solid #242b3d; box-shadow: 0 20px 50px rgba(0,0,0,0.55); }
    .tt-player-box video, .tt-player-box iframe { width: 100%; height: 100%; display: block; border: 0; object-fit: contain; background: #000; }
    .tt-controls { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 12px; }
    .tt-btn { background: #171d2b; border: 1px solid #2b344a; color: #e2e8f0; padding: 8px 14px; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .tt-btn.primary { background: #fe2c55; border-color: #fe2c55; color: #fff; }
    .tt-btn.is-active { background: #25f4ee; border-color: #25f4ee; color: #041e24; }
    .tt-info-card { width: 100%; max-width: 560px; margin-top: 16px; background: #121722; border: 1px solid #232a3b; border-radius: 14px; padding: 16px; }
    .tt-author-row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .tt-avatar { width: 42px; height: 42px; border-radius: 50%; object-fit: cover; background: #252d40; }
    .tt-handle { font-weight: 700; font-size: 15px; }
    .tt-name { font-size: 12px; color: #94a3b8; }
    .tt-desc { font-size: 14px; line-height: 1.5; color: #e2e8f0; margin-bottom: 10px; word-break: break-word; }
    .tt-music { font-size: 12px; color: #25f4ee; margin-bottom: 10px; }
    .tt-stats { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: #94a3b8; }
    .tt-side-heading { margin: 0 0 12px; font-size: 15px; font-weight: 700; }
    .tt-rel-list { display: flex; flex-direction: column; gap: 10px; }
    .tt-rel-card { display: grid; grid-template-columns: 90px 1fr; gap: 10px; padding: 6px; border-radius: 10px; transition: background 0.14s; }
    .tt-rel-card:hover { background: #171d2b; }
    .tt-rel-thumb { position: relative; aspect-ratio: 9 / 13; border-radius: 8px; overflow: hidden; background: #1b2232; }
    .tt-rel-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .dur { position: absolute; right: 4px; bottom: 4px; background: rgba(0,0,0,0.82); color: #fff; font-size: 10px; font-weight: 700; padding: 2px 5px; border-radius: 4px; }
    .tt-rel-title { font-size: 13px; font-weight: 600; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .tt-rel-sub { font-size: 12px; color: #94a3b8; margin-top: 4px; }
  </style>
</head>
<body>
  <header class="tt-top">
    <a class="tt-brand" href="${escapeHtml(toProxyUrl('https://www.tiktok.com/'))}">
      <span class="tt-mark">&#9835;</span>
      <span>TikTok</span>
    </a>
    <form id="tt-search-form" class="tt-search">
      <input id="tt-search-input" type="search" placeholder="Search TikTok videos & creators..." required />
      <button type="submit">Search</button>
    </form>
    <nav class="tt-nav">
      <a class="tt-pill" href="${escapeHtml(toProxyUrl('https://www.tiktok.com/'))}">For You</a>
      <a class="tt-pill" href="${escapeHtml(toProxyUrl('https://www.tiktok.com/explore'))}">Explore</a>
    </nav>
  </header>

  <main class="tt-stage">
    <section class="tt-theater">
      <div id="tt-player-box" class="tt-player-box"></div>
      <div class="tt-controls">
        ${proxiedPlay ? '<button type="button" class="tt-btn" data-mode="stream">Direct Video</button>' : ''}
        ${proxiedEmbed ? '<button type="button" class="tt-btn" data-mode="embed">Embed Player</button>' : ''}
        ${nextHref ? `<a class="tt-btn primary" href="${escapeHtml(nextHref)}">Next TikTok &rarr;</a>` : ''}
      </div>
      <div class="tt-info-card">
        <a class="tt-author-row" href="${escapeHtml(toProxyUrl(`https://www.tiktok.com/@${detail.authorHandle}`))}">
          ${detail.authorAvatar ? `<img class="tt-avatar" src="${escapeHtml(toProxyUrl(detail.authorAvatar))}" alt="" />` : '<div class="tt-avatar"></div>'}
          <div>
            <div class="tt-handle">@${escapeHtml(detail.authorHandle)}</div>
            <div class="tt-name">${escapeHtml(detail.authorName)}</div>
          </div>
        </a>
        ${detail.desc ? `<div class="tt-desc">${escapeHtml(detail.desc)}</div>` : ''}
        ${detail.musicTitle ? `<div class="tt-music">&#9834; ${escapeHtml(detail.musicTitle)}</div>` : ''}
        <div class="tt-stats">
          ${detail.views ? `<span>${escapeHtml(detail.views)} views</span>` : ''}
          ${detail.likes ? `<span>${escapeHtml(detail.likes)} likes</span>` : ''}
          ${detail.comments ? `<span>${escapeHtml(detail.comments)} comments</span>` : ''}
          ${detail.shares ? `<span>${escapeHtml(detail.shares)} shares</span>` : ''}
        </div>
      </div>
    </section>

    <aside>
      <h2 class="tt-side-heading">Up Next</h2>
      <div class="tt-rel-list">${relatedHtml || '<div style="color:#94a3b8;font-size:13px;">Search above to browse more TikToks.</div>'}</div>
    </aside>
  </main>

  <script>
    (function() {
      var PLAY_URL = ${JSON.stringify(proxiedPlay)};
      var POSTER_URL = ${JSON.stringify(proxiedPoster)};
      var EMBED_URL = ${JSON.stringify(proxiedEmbed)};
      var NEXT_HREF = ${JSON.stringify(nextHref)};
      var box = document.getElementById('tt-player-box');
      var btns = Array.prototype.slice.call(document.querySelectorAll('.tt-controls .tt-btn[data-mode]'));

      function mount(mode) {
        box.innerHTML = '';
        btns.forEach(function(b) { b.classList.toggle('is-active', b.getAttribute('data-mode') === mode); });
        if (mode === 'stream' && PLAY_URL) {
          var v = document.createElement('video');
          v.controls = true;
          v.autoplay = true;
          v.loop = true;
          v.playsInline = true;
          if (POSTER_URL) v.poster = POSTER_URL;
          v.src = PLAY_URL;
          v.addEventListener('error', function() {
            if (EMBED_URL) mount('embed');
          }, { once: true });
          box.appendChild(v);
          return;
        }
        if (EMBED_URL) {
          var f = document.createElement('iframe');
          f.allow = 'autoplay; fullscreen; encrypted-media';
          f.allowFullscreen = true;
          f.src = EMBED_URL;
          box.appendChild(f);
        }
      }

      btns.forEach(function(b) {
        b.addEventListener('click', function() { mount(b.getAttribute('data-mode')); });
      });

      mount(PLAY_URL ? 'stream' : 'embed');

      document.addEventListener('keydown', function(ev) {
        if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
        if (ev.key === 'ArrowDown' && NEXT_HREF) {
          window.location.href = NEXT_HREF;
        }
      });

      var sf = document.getElementById('tt-search-form');
      var si = document.getElementById('tt-search-input');
      if (sf && si) {
        sf.addEventListener('submit', function(ev) {
          ev.preventDefault();
          var q = si.value.trim();
          if (!q) return;
          window.location.href = '/api/proxy?url=' + encodeURIComponent('https://www.tiktok.com/search?q=' + encodeURIComponent(q));
        });
      }
    })();
  </script>
</body>
</html>`;
}

function renderTikTokFeedPage(opts: {
  canonicalUrl: string;
  heading: string;
  searchQuery: string;
  videos: TikTokVideoCard[];
  profile?: {
    uniqueId: string;
    nickname: string;
    bio: string;
    avatar: string;
    followers: string;
    likes: string;
  } | null;
}): string {
  const pageTitle = opts.searchQuery ? `${opts.searchQuery} - TikTok` : `${opts.heading} - TikTok`;
  const bridge = buildMediaFrameBridgeScript(opts.canonicalUrl, pageTitle);
  const cardsHtml = opts.videos
    .map((v) => {
      const href = toProxyUrl(v.url);
      const thumb = v.thumbnail ? toProxyUrl(v.thumbnail) : '';
      return `<a class="tt-card" href="${escapeHtml(href)}">
        <div class="tt-card-thumb">
          ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : ''}
          ${v.duration ? `<span class="dur">${escapeHtml(v.duration)}</span>` : ''}
          <span class="play-badge">&#9654;</span>
        </div>
        <div class="tt-card-body">
          <div class="tt-card-title">${escapeHtml(v.title)}</div>
          <div class="tt-card-sub">@${escapeHtml(v.author)}</div>
        </div>
      </a>`;
    })
    .join('');

  const profileHtml = opts.profile
    ? `<section class="tt-profile">
        ${opts.profile.avatar ? `<img class="tt-profile-avatar" src="${escapeHtml(toProxyUrl(opts.profile.avatar))}" alt="" />` : '<div class="tt-profile-avatar"></div>'}
        <div>
          <h1 class="tt-profile-handle">@${escapeHtml(opts.profile.uniqueId)}</h1>
          <div class="tt-profile-name">${escapeHtml(opts.profile.nickname)}</div>
          ${opts.profile.bio ? `<p class="tt-profile-bio">${escapeHtml(opts.profile.bio)}</p>` : ''}
          <div class="tt-profile-stats">
            ${opts.profile.followers ? `<span><strong>${escapeHtml(opts.profile.followers)}</strong> Followers</span>` : ''}
            ${opts.profile.likes ? `<span><strong>${escapeHtml(opts.profile.likes)}</strong> Likes</span>` : ''}
          </div>
        </div>
      </section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  ${bridge}
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; background: #0a0c12; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    a { color: inherit; text-decoration: none; }
    .tt-top { position: sticky; top: 0; z-index: 20; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 10px 18px; background: rgba(10, 12, 18, 0.96); border-bottom: 1px solid #1e2433; backdrop-filter: blur(10px); }
    .tt-brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; font-size: 18px; }
    .tt-mark { display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 8px; background: linear-gradient(135deg, #25f4ee, #fe2c55); color: #05070c; font-weight: 900; font-size: 14px; }
    .tt-search { flex: 1; min-width: 200px; max-width: 500px; display: flex; gap: 8px; }
    .tt-search input { flex: 1; background: #131824; border: 1px solid #283044; color: #fff; padding: 9px 14px; border-radius: 999px; font-size: 14px; outline: none; }
    .tt-search input:focus { border-color: #fe2c55; }
    .tt-search button, .tt-pill { background: #171d2b; border: 1px solid #2b344a; color: #e2e8f0; padding: 8px 14px; border-radius: 999px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .tt-search button:hover, .tt-pill:hover { background: #263046; }
    .tt-nav { display: flex; gap: 8px; flex-wrap: wrap; }
    .tt-wrap { max-width: 1380px; margin: 0 auto; padding: 20px 18px 40px; }
    .tt-h1 { margin: 0 0 18px; font-size: 21px; font-weight: 700; }
    .tt-profile { display: flex; align-items: center; gap: 18px; background: #121722; border: 1px solid #232a3b; border-radius: 16px; padding: 20px; margin-bottom: 22px; }
    .tt-profile-avatar { width: 76px; height: 76px; border-radius: 50%; object-fit: cover; background: #252d40; flex-shrink: 0; }
    .tt-profile-handle { margin: 0 0 4px; font-size: 22px; }
    .tt-profile-name { font-size: 14px; color: #94a3b8; margin-bottom: 8px; }
    .tt-profile-bio { margin: 0 0 10px; font-size: 13px; color: #cbd5e1; max-width: 620px; }
    .tt-profile-stats { display: flex; gap: 16px; font-size: 13px; color: #94a3b8; }
    .tt-profile-stats strong { color: #fff; }
    .tt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 16px; }
    .tt-card { display: flex; flex-direction: column; border-radius: 14px; background: #121722; border: 1px solid #22293a; overflow: hidden; transition: transform 0.14s, border-color 0.14s; }
    .tt-card:hover { transform: translateY(-2px); border-color: #fe2c55; }
    .tt-card-thumb { position: relative; aspect-ratio: 9 / 13; background: #192030; }
    .tt-card-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .dur { position: absolute; right: 8px; bottom: 8px; background: rgba(0, 0, 0, 0.84); color: #fff; font-size: 11px; font-weight: 700; padding: 2px 6px; border-radius: 4px; }
    .play-badge { position: absolute; left: 8px; bottom: 8px; width: 26px; height: 26px; border-radius: 50%; background: rgba(0, 0, 0, 0.65); color: #fff; display: grid; place-items: center; font-size: 11px; }
    .tt-card-body { padding: 11px 12px; }
    .tt-card-title { font-size: 13px; font-weight: 600; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 5px; }
    .tt-card-sub { font-size: 12px; color: #25f4ee; }
  </style>
</head>
<body>
  <header class="tt-top">
    <a class="tt-brand" href="${escapeHtml(toProxyUrl('https://www.tiktok.com/'))}">
      <span class="tt-mark">&#9835;</span>
      <span>TikTok</span>
    </a>
    <form id="tt-search-form" class="tt-search">
      <input id="tt-search-input" type="search" value="${escapeHtml(opts.searchQuery)}" placeholder="Search any TikTok topic, sound, or creator..." required />
      <button type="submit">Search</button>
    </form>
    <nav class="tt-nav">
      <a class="tt-pill" href="${escapeHtml(toProxyUrl('https://www.tiktok.com/'))}">For You</a>
      <a class="tt-pill" href="${escapeHtml(toProxyUrl('https://www.tiktok.com/search?q=comedy'))}">Comedy</a>
      <a class="tt-pill" href="${escapeHtml(toProxyUrl('https://www.tiktok.com/search?q=gaming'))}">Gaming</a>
      <a class="tt-pill" href="${escapeHtml(toProxyUrl('https://www.tiktok.com/search?q=music'))}">Music</a>
      <a class="tt-pill" href="${escapeHtml(toProxyUrl('https://www.tiktok.com/search?q=sports'))}">Sports</a>
    </nav>
  </header>

  <main class="tt-wrap">
    ${profileHtml}
    <h1 class="tt-h1">${escapeHtml(opts.heading)}</h1>
    ${
      cardsHtml
        ? `<div class="tt-grid">${cardsHtml}</div>`
        : '<p style="color:#94a3b8;">No TikTok videos matched. Try searching above.</p>'
    }
  </main>

  <script>
    (function() {
      var sf = document.getElementById('tt-search-form');
      var si = document.getElementById('tt-search-input');
      if (sf && si) {
        sf.addEventListener('submit', function(ev) {
          ev.preventDefault();
          var q = si.value.trim();
          if (!q) return;
          window.location.href = '/api/proxy?url=' + encodeURIComponent('https://www.tiktok.com/search?q=' + encodeURIComponent(q));
        });
      }
    })();
  </script>
</body>
</html>`;
}

async function handleTikTokProxyRequest(target: URL, sid: string, res: Response): Promise<boolean> {
  if (target.searchParams.get('yamal_raw') === '1') {
    return false;
  }

  let resolvedTarget = target;
  const hostLower = target.hostname.toLowerCase();
  if (hostLower === 'vm.tiktok.com' || hostLower === 'vt.tiktok.com' || target.pathname.startsWith('/t/')) {
    try {
      const r = await fetch(target.toString(), {
        headers: { 'User-Agent': STREAM_UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(9000),
      });
      const finalUrl = normalizeTargetUrl(r.url || '');
      if (finalUrl && isTikTokHost(finalUrl.hostname)) {
        resolvedTarget = finalUrl;
      }
    } catch {
      // Keep original URL
    }
  }

  const videoId = extractTikTokVideoId(resolvedTarget);
  if (videoId) {
    const detail = await resolveTikTokVideoDetail(resolvedTarget.toString(), sid);
    if (detail) {
      const relatedQuery = detail.authorHandle && detail.authorHandle !== 'tiktok' ? detail.authorHandle : 'trending viral';
      const related = await fetchTikTokVideosFromBing(relatedQuery, 16);
      const html = renderTikTokWatchPage(detail, related);
      res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
      return true;
    }
  }

  const pathname = resolvedTarget.pathname;
  const searchQuery = resolvedTarget.searchParams.get('q') || resolvedTarget.searchParams.get('keyword') || '';

  if (searchQuery) {
    const videos = await fetchTikTokVideosFromBing(searchQuery, 30);
    const html = renderTikTokFeedPage({
      canonicalUrl: resolvedTarget.toString(),
      heading: `Search: ${searchQuery}`,
      searchQuery,
      videos,
    });
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    return true;
  }

  const tagMatch = pathname.match(/^\/tag\/([^/]+)/i);
  if (tagMatch) {
    const tag = decodeURIComponent(tagMatch[1]);
    const videos = await fetchTikTokVideosFromBing(`#${tag}`, 30);
    const html = renderTikTokFeedPage({
      canonicalUrl: resolvedTarget.toString(),
      heading: `#${tag}`,
      searchQuery: tag,
      videos,
    });
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    return true;
  }

  const profileMatch = pathname.match(/^\/@([^/]+)\/?$/);
  if (profileMatch) {
    const handle = decodeURIComponent(profileMatch[1]);
    let profileInfo: {
      uniqueId: string;
      nickname: string;
      bio: string;
      avatar: string;
      followers: string;
      likes: string;
    } | null = null;
    try {
      const pRes = await fetch(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, {
        headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(10000),
      });
      const pHtml = await pRes.text();
      const universal = extractScriptJsonById(pHtml, '__UNIVERSAL_DATA_FOR_REHYDRATION__') as Record<string, unknown> | null;
      const ud = (universal?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined)?.['webapp.user-detail'] as
        | Record<string, unknown>
        | undefined;
      const uInfo = ud?.userInfo as Record<string, unknown> | undefined;
      const userObj = uInfo?.user as Record<string, unknown> | undefined;
      const statsObj = uInfo?.stats as Record<string, unknown> | undefined;
      if (userObj) {
        profileInfo = {
          uniqueId: typeof userObj.uniqueId === 'string' ? userObj.uniqueId : handle,
          nickname: typeof userObj.nickname === 'string' ? userObj.nickname : handle,
          bio: typeof userObj.signature === 'string' ? userObj.signature : '',
          avatar: typeof userObj.avatarMedium === 'string' ? userObj.avatarMedium : '',
          followers: formatCompactCount(statsObj?.followerCount as number | undefined),
          likes: formatCompactCount(statsObj?.heartCount as number | undefined),
        };
      }
    } catch {
      profileInfo = null;
    }

    let videos = await fetchTikTokVideosFromBing(`@${handle}`, 28);
    if (videos.length === 0) {
      videos = await fetchTikTokVideosFromBing(handle, 24);
    }
    const html = renderTikTokFeedPage({
      canonicalUrl: resolvedTarget.toString(),
      heading: `Videos from @${handle}`,
      searchQuery: '',
      videos,
      profile: profileInfo,
    });
    res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(html);
    return true;
  }

  // TikTok Home / Explore / Login redirect bypass
  const bingVideos = await fetchTikTokVideosFromBing('trending viral fyp', 32);
  let featuredVideos = bingVideos;
  try {
    const homeRes = await fetch('https://www.tiktok.com/', {
      headers: { 'User-Agent': STREAM_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });
    const setCookies = typeof homeRes.headers.getSetCookie === 'function' ? homeRes.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      storeUpstreamCookies(sid, new URL('https://www.tiktok.com/'), setCookies);
    }
    const homeHtml = await homeRes.text();
    const universal = extractScriptJsonById(homeHtml, '__UNIVERSAL_DATA_FOR_REHYDRATION__') as Record<string, unknown> | null;
    const fy = (universal?.__DEFAULT_SCOPE__ as Record<string, unknown> | undefined)?.['webapp.foryou.video'] as
      | Record<string, unknown>
      | undefined;
    const itemList = Array.isArray(fy?.itemList) ? (fy?.itemList as Array<Record<string, unknown>>) : [];
    const ssrCards: TikTokVideoCard[] = [];
    for (const item of itemList) {
      const id = typeof item.id === 'string' ? item.id : '';
      const author = typeof (item.author as Record<string, unknown> | undefined)?.uniqueId === 'string'
        ? ((item.author as Record<string, unknown>).uniqueId as string)
        : '';
      const cover = typeof (item.video as Record<string, unknown> | undefined)?.cover === 'string'
        ? ((item.video as Record<string, unknown>).cover as string)
        : '';
      const dur = formatDurationSeconds((item.video as Record<string, unknown> | undefined)?.duration as number | undefined);
      if (id && author) {
        ssrCards.push({
          videoId: id,
          url: `https://www.tiktok.com/@${author}/video/${id}`,
          title: typeof item.desc === 'string' && item.desc.trim() ? item.desc.trim() : `TikTok by @${author}`,
          author,
          authorUrl: `https://www.tiktok.com/@${author}`,
          thumbnail: cover,
          duration: dur,
        });
      }
    }
    if (ssrCards.length > 0) {
      const seenIds = new Set(ssrCards.map((c) => c.videoId));
      featuredVideos = [...ssrCards, ...bingVideos.filter((v) => !seenIds.has(v.videoId))];
    }
  } catch {
    // Keep bingVideos
  }

  const outHtml = renderTikTokFeedPage({
    canonicalUrl: 'https://www.tiktok.com/',
    heading: pathname.startsWith('/explore') ? 'Explore TikTok' : 'For You',
    searchQuery: '',
    videos: featuredVideos,
  });
  res.status(200).setHeader('Content-Type', 'text/html; charset=utf-8').send(outHtml);
  return true;
}

async function proxyTargetUrl(target: URL, req: Request, res: Response, redirectDepth = 0): Promise<void> {
  try {
    if (redirectDepth < 3) {
      const bingDest = extractBingClickTarget(target);
      if (bingDest) {
        await proxyTargetUrl(bingDest, req, res, redirectDepth + 1);
        return;
      }
    }

    const sid = getOrCreateSessionId(req, res);
    const method = req.method.toUpperCase();
    const acceptHeader =
      req.headers.accept ||
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
    const isDocumentReq = acceptHeader.includes('text/html');

    if (method === 'GET' && isDocumentReq) {
      if (isYoutubeHost(target.hostname)) {
        const handled = await handleYoutubeProxyRequest(target, sid, res);
        if (handled) return;
      }
      if (isTikTokHost(target.hostname)) {
        const handled = await handleTikTokProxyRequest(target, sid, res);
        if (handled) return;
      }
    }

    let upstreamReferer = target.origin + '/';
    const rawReqRef = typeof req.headers.referer === 'string' ? req.headers.referer : '';
    if (rawReqRef.includes('/api/proxy?url=')) {
      try {
        const refParsed = new URL(rawReqRef);
        const refTarget = refParsed.searchParams.get('url');
        if (refTarget) {
          const refTargetUrl = new URL(refTarget);
          if (refTargetUrl.origin === target.origin) {
            upstreamReferer = refTargetUrl.toString();
          }
        }
      } catch {
        // Keep origin referer
      }
    }

    if (isTikTokAssetOrCdnHost(target.hostname)) {
      upstreamReferer = 'https://www.tiktok.com/';
    } else if (
      (target.hostname.toLowerCase() === 'www.youtube-nocookie.com' ||
        target.hostname.toLowerCase() === 'www.youtube.com') &&
      target.pathname.startsWith('/embed/')
    ) {
      upstreamReferer = 'https://yamal-browser.app/';
    }

    const forwardHeaders: Record<string, string> = {
      'User-Agent': STREAM_UA,
      Accept: acceptHeader,
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: upstreamReferer,
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': isDocumentReq ? 'document' : 'empty',
      'Sec-Fetch-Mode': isDocumentReq ? 'navigate' : 'cors',
      'Sec-Fetch-Site': isDocumentReq ? 'none' : 'same-origin',
    };

    if (typeof req.headers.range === 'string') {
      forwardHeaders['Range'] = req.headers.range;
    }
    if (typeof req.headers['if-range'] === 'string') {
      forwardHeaders['If-Range'] = req.headers['if-range'];
    }
    if (method !== 'GET' && method !== 'HEAD') {
      forwardHeaders['Origin'] = isTikTokAssetOrCdnHost(target.hostname) ? 'https://www.tiktok.com' : target.origin;
    }
    for (const [headerName, headerVal] of Object.entries(req.headers)) {
      const lower = headerName.toLowerCase();
      if (
        (lower === 'authorization' ||
          lower === 'x-requested-with' ||
          lower === 'x-csrf-token' ||
          lower === 'x-xsrf-token' ||
          lower.startsWith('x-ngg-') ||
          lower.startsWith('x-youtube-') ||
          lower.startsWith('x-goog-')) &&
        typeof headerVal === 'string'
      ) {
        forwardHeaders[headerName] = headerVal;
      }
    }

    let storedCookies = getMatchingCookies(sid, target, true);
    if (storedCookies.length === 0 && isTikTokAssetOrCdnHost(target.hostname)) {
      storedCookies = getMatchingCookies(sid, new URL('https://www.tiktok.com/'), true);
    }
    if (storedCookies.length > 0) {
      forwardHeaders['Cookie'] = storedCookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } else if (isTikTokAssetOrCdnHost(target.hostname) && latestTikTokCookieHeader) {
      forwardHeaders['Cookie'] = latestTikTokCookieHeader;
    }

    const fetchOptions: RequestInit = {
      method,
      headers: forwardHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(45000),
    };

    if (method !== 'GET' && method !== 'HEAD' && req.body !== undefined) {
      const incomingContentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
      if (typeof req.body === 'string') {
        fetchOptions.body = req.body;
        if (incomingContentType) forwardHeaders['Content-Type'] = incomingContentType;
      } else if (Buffer.isBuffer(req.body)) {
        if (req.body.byteLength > 0) {
          fetchOptions.body = new Uint8Array(req.body);
          if (incomingContentType) forwardHeaders['Content-Type'] = incomingContentType;
        }
      } else if (typeof req.body === 'object' && req.body !== null) {
        if (incomingContentType.includes('application/x-www-form-urlencoded')) {
          if (Object.keys(req.body).length > 0) {
            const params = new URLSearchParams();
            for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
              params.append(k, String(v));
            }
            fetchOptions.body = params.toString();
            forwardHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
          }
        } else if (incomingContentType.includes('application/json') || Object.keys(req.body).length > 0) {
          fetchOptions.body = JSON.stringify(req.body);
          forwardHeaders['Content-Type'] = 'application/json';
        }
      }
    }

    let upstream = await fetch(target.toString(), fetchOptions);

    if (
      (upstream.status === 403 || upstream.status === 451) &&
      (target.hostname.toLowerCase() === 'cdn.jsdelivr.net' || target.hostname.toLowerCase().endsWith('.jsdelivr.net')) &&
      redirectDepth < 2
    ) {
      const fallbacks = resolveJsDelivrFallbackUrls(target);
      for (const fbUrl of fallbacks) {
        const fbRes = await fetch(fbUrl.toString(), { ...fetchOptions, headers: { ...forwardHeaders, Referer: fbUrl.origin + '/' } });
        if (fbRes.ok) {
          upstream = fbRes;
          break;
        }
      }
    }

    let finalUrl = upstream.url || target.toString();
    let finalParsed = new URL(finalUrl);

    if (redirectDepth < 3 && method === 'GET' && isDocumentReq) {
      const fHost = finalParsed.hostname.toLowerCase();
      if (fHost === 'accounts.google.com' || fHost === 'consent.youtube.com') {
        const cont = finalParsed.searchParams.get('continue');
        const contUrl = cont ? normalizeTargetUrl(cont) : null;
        if (contUrl && isYoutubeHost(contUrl.hostname)) {
          const handled = await handleYoutubeProxyRequest(contUrl, sid, res);
          if (handled) return;
        }
      }
      if (isTikTokHost(fHost) && /^\/(login|passport)/i.test(finalParsed.pathname)) {
        const redir = finalParsed.searchParams.get('redirect_url');
        const redirUrl = (redir ? normalizeTargetUrl(redir) : null) || new URL('https://www.tiktok.com/');
        const handled = await handleTikTokProxyRequest(redirUrl, sid, res);
        if (handled) return;
      }
    }

    if (isPrivateOrBlockedHost(finalParsed.hostname)) {
      res
        .status(403)
        .type('text/html')
        .send(renderProxyErrorPage(finalUrl, 'Redirected to a restricted host address.'));
      return;
    }

    const isNowggOapi = isNowggHost(finalParsed.hostname) && /^\/oapi\/(?:\d+\/)?/.test(finalParsed.pathname);
    let preReadText: string | null = null;
    if (isNowggOapi && !/^\/oapi\/7\//.test(finalParsed.pathname)) {
      const rawCt = (upstream.headers.get('content-type') || '').toLowerCase();
      if (rawCt.includes('text/html') || rawCt.includes('application/xml') || upstream.status === 403) {
        preReadText = await upstream.text();
        if (isNowggCloudFrontProxyError(finalParsed, upstream, preReadText)) {
          const oapi7Url = new URL(target.toString());
          oapi7Url.hostname = 'now.gg';
          oapi7Url.pathname = target.pathname.replace(/^\/oapi\/(?:\d+\/)?/, '/oapi/7/');
          const retryHeaders: Record<string, string> = {
            ...forwardHeaders,
            Referer: 'https://now.gg/apps/a/19900/b.html',
          };
          if (method !== 'GET' && method !== 'HEAD') {
            retryHeaders['Origin'] = 'https://now.gg';
          }
          const retryRes = await fetch(oapi7Url.toString(), {
            ...fetchOptions,
            headers: retryHeaders,
          });
          upstream = retryRes;
          finalUrl = retryRes.url || oapi7Url.toString();
          finalParsed = new URL(finalUrl);
          preReadText = null;
        }
      }
    }

    const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
    if (setCookies.length > 0) {
      storeUpstreamCookies(sid, finalParsed, setCookies);
    }

    const rawContentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentType = inferContentType(finalParsed.pathname, rawContentType);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Proxied-URL', finalUrl);

    if (isNowggOapi && upstream.status === 205) {
      res.status(200).json(buildNowggOapiFallbackJson(finalParsed.pathname));
      return;
    }

    if (isNowggOapi && contentType.includes('application/json')) {
      const jsonText = preReadText !== null ? preReadText : await upstream.text();
      const sanitized = sanitizeNowggJsonResponse(finalParsed.pathname, jsonText);
      res.status(upstream.status).setHeader('Content-Type', 'application/json; charset=utf-8').send(sanitized);
      return;
    }

    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || (isNowggOapi && contentType.includes('xml'))) {
      const html = preReadText !== null ? preReadText : await upstream.text();

      if (
        isNowggOapi &&
        (upstream.status >= 400 || isNowggCloudFrontProxyError(finalParsed, upstream, html))
      ) {
        const fallbackPayload = buildNowggOapiFallbackJson(finalParsed.pathname);
        res.status(200).json(fallbackPayload);
        return;
      }

      if (
        (finalParsed.pathname.startsWith('/oapi/') || !isDocumentReq || method !== 'GET') &&
        isNowggCloudFrontProxyError(finalParsed, upstream, html)
      ) {
        const fallbackPayload = buildNowggOapiFallbackJson(finalParsed.pathname);
        res.status(200).json(fallbackPayload);
        return;
      }

      if (redirectDepth < 3) {
        const jsRedirect = extractJsRedirectTarget(html, finalUrl);
        if (jsRedirect && jsRedirect.toString() !== finalUrl) {
          await proxyTargetUrl(jsRedirect, req, res, redirectDepth + 1);
          return;
        }
      }

      const isBotBlock =
        upstream.status === 429 ||
        upstream.status === 403 ||
        /<title>\s*(Just a moment\.\.\.|Client Challenge|Attention Required!)/i.test(html);

      if (isBotBlock) {
        const searchQ = target.searchParams.get('q') || target.hostname.replace(/^www\./, '');
        res
          .status(200)
          .type('text/html')
          .send(
            renderProxyErrorPage(
              finalUrl,
              'This site blocked automated cloud-proxy requests (HTTP ' +
                upstream.status +
                ' / bot verification). Try searching for it on Bing or opening another site.',
              `https://www.bing.com/search?q=${encodeURIComponent(searchQ)}`
            )
          );
        return;
      }

      const baseMatch = html.match(/<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
      const effectiveBaseCookie = baseMatch
        ? resolveMaybeUrl(decodeHtmlEntities(baseMatch[1] ?? baseMatch[2] ?? baseMatch[3] ?? '').trim(), finalUrl) || finalUrl
        : finalUrl;
      let effectiveOrigin = finalParsed.origin;
      try {
        effectiveOrigin = new URL(effectiveBaseCookie).origin;
      } catch {
        // Keep finalParsed origin
      }

      res.cookie('yamal_origin', effectiveOrigin, {
        path: '/',
        sameSite: 'lax',
        httpOnly: true,
      });
      res.cookie('yamal_base', effectiveBaseCookie, {
        path: '/',
        sameSite: 'lax',
        httpOnly: true,
      });
      const clientCookies = getMatchingCookies(sid, finalParsed, false).map((c) => ({
        name: c.name,
        value: c.value,
      }));
      const rewritten = rewriteHtml(html, finalUrl, clientCookies);
      res.status(upstream.status).setHeader('Content-Type', 'text/html; charset=utf-8').send(rewritten);
      return;
    }

    if (contentType.includes('text/css')) {
      const css = await upstream.text();
      const rewrittenCss = rewriteCss(css, finalUrl);
      res.status(upstream.status).setHeader('Content-Type', 'text/css; charset=utf-8').send(rewrittenCss);
      return;
    }

    if (
      contentType.includes('javascript') ||
      contentType.includes('ecmascript') ||
      finalParsed.pathname.toLowerCase().endsWith('.js') ||
      finalParsed.pathname.toLowerCase().endsWith('.mjs')
    ) {
      const jsText = await upstream.text();
      const rewrittenJs = rewriteJavaScript(jsText, finalUrl);
      res.status(upstream.status).setHeader('Content-Type', 'application/javascript; charset=utf-8').send(rewrittenJs);
      return;
    }

    const contentEncoding = upstream.headers.get('content-encoding');
    const contentRange = upstream.headers.get('content-range');
    const acceptRanges = upstream.headers.get('accept-ranges');
    const contentLength = !contentEncoding ? upstream.headers.get('content-length') : null;
    if (contentRange) res.setHeader('Content-Range', contentRange);
    if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    res.status(upstream.status).setHeader('Content-Type', contentType);

    const parsedLength = contentLength ? Number(contentLength) : 0;
    const isStreamMedia =
      upstream.status === 206 ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      (!contentEncoding && Number.isFinite(parsedLength) && parsedLength > 2_000_000);
    if (isStreamMedia && upstream.body) {
      Readable.fromWeb(upstream.body as unknown as NodeReadableStream).pipe(res);
      return;
    }

    const arrayBuf = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    res.send(buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed';
    if (!res.headersSent) {
      res.status(502).type('text/html').send(renderProxyErrorPage(target.toString(), message));
    } else {
      res.end();
    }
  }
}

async function handleProxy(req: Request, res: Response): Promise<void> {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  const target = normalizeTargetUrl(rawUrl);

  if (!target) {
    res
      .status(400)
      .type('text/html')
      .send(renderProxyErrorPage(rawUrl || 'Empty URL', 'Enter a valid public http:// or https:// web address.'));
    return;
  }

  await proxyTargetUrl(target, req, res);
}

const APP_EXACT_PATHS = new Set(['/', '/index.html', '/unblocker.html', '/unblocker', '/favicon.ico', '/api/unlock']);
const APP_PATH_PREFIXES = ['/src/', '/assets/', '/@vite/', '/@fs/', '/@id/', '/node_modules/', '/api/proxy', '/api/games'];

function isLocalAppPath(pathname: string): boolean {
  if (APP_EXACT_PATHS.has(pathname)) return true;
  return APP_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}

// Transparent fallback for root-relative assets and SPA route reloads requested from inside a proxied iframe
function handleRefererSubresourceFallback(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith('/api/proxy')) {
    next();
    return;
  }

  let upstreamBase: string | null = null;
  const referer = req.headers.referer;
  if (referer && referer.includes('/api/proxy?url=')) {
    try {
      const refUrl = new URL(referer);
      upstreamBase = refUrl.searchParams.get('url');
    } catch {
      upstreamBase = null;
    }
  }

  if (!upstreamBase && !isLocalAppPath(req.path)) {
    const cookieBase = readCookie(req.headers.cookie, 'yamal_base');
    const cookieOrigin = readCookie(req.headers.cookie, 'yamal_origin');
    if (cookieBase && /^https?:\/\//i.test(cookieBase)) {
      upstreamBase = cookieBase;
    } else if (cookieOrigin && /^https?:\/\//i.test(cookieOrigin)) {
      upstreamBase = cookieOrigin;
    }
  }

  if (!upstreamBase) {
    next();
    return;
  }

  try {
    const resolved = new URL(req.originalUrl, upstreamBase);
    if (isPrivateOrBlockedHost(resolved.hostname)) {
      res.status(403).end();
      return;
    }
    void proxyTargetUrl(resolved, req, res);
  } catch {
    next();
  }
}

interface GameCatalogEntry {
  id: string;
  title: string;
  source: 'gn-math' | 'strongdog' | 'now.gg';
  category: string;
  url: string;
  cover: string;
}

const NOWGG_FEATURED_GAMES: GameCatalogEntry[] = [
  {
    id: 'nowgg-roblox',
    title: 'Roblox',
    source: 'now.gg',
    category: 'Multiplayer',
    url: 'https://now.gg/apps/a/19900/b.html?ng_ntmSource=PopularGames',
    cover: 'https://cdn.now.gg/apps-content/com.roblox.client/game-tiles/roblox.jpg',
  },
];

const FALLBACK_GAMES: GameCatalogEntry[] = [
  ...NOWGG_FEATURED_GAMES,
  {
    id: 'gn-1',
    title: 'OvO',
    source: 'gn-math',
    category: 'Platformer',
    url: 'https://raw.githubusercontent.com/gn-math/html/main/1-fix2.html',
    cover: 'https://raw.githubusercontent.com/gn-math/covers/main/1.png',
  },
  {
    id: 'gn-6',
    title: 'Block Blast',
    source: 'gn-math',
    category: 'Puzzle',
    url: 'https://raw.githubusercontent.com/gn-math/html/main/6-fix3.html',
    cover: 'https://raw.githubusercontent.com/gn-math/covers/main/6.png',
  },
  {
    id: 'gn-7',
    title: 'Jetpack Joyride',
    source: 'gn-math',
    category: 'Arcade',
    url: 'https://raw.githubusercontent.com/gn-math/html/main/7-fix3.html',
    cover: 'https://raw.githubusercontent.com/gn-math/covers/main/7.png',
  },
  {
    id: 'gn-10',
    title: 'Temple Run 2',
    source: 'gn-math',
    category: 'Runner',
    url: 'https://raw.githubusercontent.com/gn-math/html/main/10-fix2.html',
    cover: 'https://raw.githubusercontent.com/gn-math/covers/main/10.png',
  },
  {
    id: 'sd-2048',
    title: '2048',
    source: 'strongdog',
    category: 'Puzzle Games',
    url: 'https://strongdog-xp.com/embed/2048/',
    cover: '',
  },
  {
    id: 'sd-hextris',
    title: 'Hextris',
    source: 'strongdog',
    category: 'Puzzle Games',
    url: 'https://strongdog-xp.com/embed/hextris/',
    cover: '',
  },
  {
    id: 'sd-chess',
    title: 'Chess vs Computer',
    source: 'strongdog',
    category: 'Card and Board Games',
    url: 'https://strongdog-xp.com/embed/chess-vs-computer/',
    cover: '',
  },
  {
    id: 'sd-checkers',
    title: 'Checkers',
    source: 'strongdog',
    category: 'Card and Board Games',
    url: 'https://strongdog-xp.com/embed/checkers/',
    cover: '',
  },
];

let cachedGamesCatalog: { expiresAt: number; games: GameCatalogEntry[] } | null = null;

async function fetchGamesCatalog(): Promise<GameCatalogEntry[]> {
  if (cachedGamesCatalog && Date.now() < cachedGamesCatalog.expiresAt) {
    return cachedGamesCatalog.games;
  }

  const games: GameCatalogEntry[] = [...NOWGG_FEATURED_GAMES];

  try {
    const gnRes = await fetch('https://raw.githubusercontent.com/gn-math/assets/main/zones.json', {
      signal: AbortSignal.timeout(8000),
    });
    if (gnRes.ok) {
      const zones = (await gnRes.json()) as Array<{
        id?: number;
        name?: string;
        url?: string;
        cover?: string;
        special?: string[];
      }>;
      if (Array.isArray(zones)) {
        for (const z of zones) {
          if (!z || typeof z.id !== 'number' || z.id < 0 || !z.name || !z.url) continue;
          const resolvedUrl = z.url
            .replace(/\{HTML_URL\}/g, 'https://raw.githubusercontent.com/gn-math/html/main')
            .replace(/\{COVER_URL\}/g, 'https://raw.githubusercontent.com/gn-math/covers/main');
          if (!/^https?:\/\//i.test(resolvedUrl) || resolvedUrl.includes('discord.gg')) continue;
          const resolvedCover = (z.cover || '')
            .replace(/\{COVER_URL\}/g, 'https://raw.githubusercontent.com/gn-math/covers/main')
            .replace(/\{HTML_URL\}/g, 'https://raw.githubusercontent.com/gn-math/html/main');
          games.push({
            id: `gn-${z.id}`,
            title: String(z.name).trim(),
            source: 'gn-math',
            category: Array.isArray(z.special) && z.special.length > 0 ? String(z.special[0]) : 'gn-math',
            url: resolvedUrl,
            cover: /^https?:\/\//i.test(resolvedCover) ? resolvedCover : '',
          });
        }
      }
    }
  } catch {
    // Fall through to StrongDog and fallback list
  }

  try {
    const sdRes = await fetch('https://strongdog-xp.com/search-index.json', {
      signal: AbortSignal.timeout(8000),
    });
    if (sdRes.ok) {
      const items = (await sdRes.json()) as Array<{
        t?: string;
        s?: string;
        c?: string;
        i?: string;
      }>;
      if (Array.isArray(items)) {
        for (const item of items) {
          if (!item || !item.t || !item.s) continue;
          const slug = String(item.s).replace(/^\/+|\/+$/g, '');
          const coverPath = item.i ? String(item.i) : '';
          games.push({
            id: `sd-${slug}`,
            title: String(item.t).trim(),
            source: 'strongdog',
            category: item.c ? String(item.c).trim() : 'StrongDog',
            url: `https://strongdog-xp.com/embed/${slug}/`,
            cover: coverPath
              ? coverPath.startsWith('http')
                ? coverPath
                : `https://strongdog-xp.com${coverPath.startsWith('/') ? '' : '/'}${coverPath}`
              : '',
          });
        }
      }
    }
  } catch {
    // Keep any loaded games
  }

  const result = games.length > NOWGG_FEATURED_GAMES.length ? games : FALLBACK_GAMES;
  if (games.length > NOWGG_FEATURED_GAMES.length) {
    cachedGamesCatalog = {
      expiresAt: Date.now() + 60 * 60 * 1000,
      games: result,
    };
  }
  return result;
}

function renderNotFoundPage(requestPath: string): string {
  const safePath = escapeHtml(requestPath || '/');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>404 Not Found</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      background: #f4f7fa;
      color: #132238;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .nf-card {
      max-width: 460px;
      width: 100%;
      background: #ffffff;
      border: 1px solid #dce4ee;
      border-radius: 14px;
      padding: 36px 32px;
      text-align: center;
    }
    .nf-code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 48px;
      font-weight: 700;
      line-height: 1;
      color: #0284c7;
      margin: 0 0 12px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 22px;
      font-weight: 700;
    }
    p {
      margin: 0 0 24px;
      font-size: 14px;
      color: #4a5d75;
      line-height: 1.6;
      word-break: break-word;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #eaf0f6;
      padding: 2px 6px;
      border-radius: 4px;
      color: #132238;
    }
    a {
      display: inline-block;
      padding: 11px 22px;
      background: #0284c7;
      color: #ffffff;
      text-decoration: none;
      font-weight: 600;
      font-size: 14px;
      border-radius: 10px;
    }
    a:hover { background: #0369a1; }
  </style>
</head>
<body>
  <main class="nf-card">
    <div class="nf-code">404</div>
    <h1>Page Not Found</h1>
    <p>The requested path <code>${safePath}</code> could not be found on this server.</p>
    <a href="/">Return to Calculator</a>
  </main>
</body>
</html>`;
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/proxy', express.text({ type: 'text/*', limit: '2mb' }));
  app.use('/api/proxy', express.raw({ type: '*/*', limit: '5mb' }));

  app.post('/api/unlock', (req, res) => {
    const body = req.body as { code?: unknown } | undefined;
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (code !== '0000') {
      res.status(403).json({ ok: false });
      return;
    }
    const isHttps =
      req.secure ||
      req.headers['x-forwarded-proto'] === 'https' ||
      (typeof req.headers.origin === 'string' && req.headers.origin.startsWith('https://')) ||
      (typeof req.headers.referer === 'string' && req.headers.referer.startsWith('https://'));
    res.cookie('yamal_unlocked', '1', {
      path: '/',
      maxAge: 365 * 24 * 60 * 60 * 1000,
      sameSite: isHttps ? 'none' : 'lax',
      secure: isHttps,
      httpOnly: true,
    });
    res.json({ ok: true });
  });

  app.get('/api/games', async (_req, res) => {
    const games = await fetchGamesCatalog();
    res.json({ games });
  });

  app.all('/api/proxy', (req, res) => {
    void handleProxy(req, res);
  });

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const unlocked = readCookie(req.headers.cookie, 'yamal_unlocked') === '1';
    const isUnblockerPath =
      req.path === '/unblocker.html' ||
      req.path === '/unblocker' ||
      req.path === '/unblocker/' ||
      req.path === '/unblocker.html/';

    if (isUnblockerPath) {
      res.setHeader('Cache-Control', 'no-store');
      if (!unlocked) {
        res.status(404).type('text/html').send(renderNotFoundPage(req.path));
        return;
      }
      if (req.path !== '/unblocker.html') {
        res.redirect(302, '/unblocker.html');
        return;
      }
    } else if ((req.path === '/' || req.path === '/index.html') && unlocked) {
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, '/unblocker.html');
      return;
    }

    next();
  });

  app.use(handleRefererSubresourceFallback);

  if (!isProd) {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      const unlocked = readCookie(req.headers.cookie, 'yamal_unlocked') === '1';
      if (unlocked) {
        res.redirect(302, '/unblocker.html');
        return;
      }
      if (
        req.path === '/unblocker.html' ||
        req.path === '/unblocker' ||
        req.path === '/unblocker/' ||
        req.path === '/unblocker.html/'
      ) {
        res.status(404).type('text/html').send(renderNotFoundPage(req.path));
        return;
      }
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
