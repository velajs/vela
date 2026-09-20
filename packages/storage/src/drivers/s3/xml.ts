// Dependency-free, edge-safe S3 XML helpers. Workers has no `DOMParser` and
// the AWS XML parser is banned, so we extract from S3's fixed, shallow,
// documented response shapes (ListBucketResult, Initiate/CompleteMultipartUpload,
// Error, ...) with anchored, ReDoS-free regexes. We never parse untrusted XML.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function unescapeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _m;
    }
    return ENTITIES[e] ?? _m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

// Each pattern uses a single non-greedy `[\s\S]*?` bounded by a literal close
// tag → linear time, no nested quantifiers, no catastrophic backtracking.
function tagPattern(tag: string): string {
  return `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`;
}

/** First `<tag>…</tag>` inner text (entity-decoded), or `undefined`. */
export function tagText(xml: string, tag: string): string | undefined {
  const m = new RegExp(tagPattern(tag)).exec(xml);
  return m ? unescapeXml(m[1]!) : undefined;
}

/** All `<tag>…</tag>` inner blocks (raw, not decoded — for nested extraction). */
export function tagBlocks(xml: string, tag: string): string[] {
  const re = new RegExp(tagPattern(tag), 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]!);
  return out;
}
