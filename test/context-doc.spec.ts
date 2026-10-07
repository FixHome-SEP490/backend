import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Checks docs/CONTEXT.md against the rules written in its section 0. The same
 * rules live in all four FixHome repositories (ai-service has a Python copy in
 * tests/test_context_doc.py); change them everywhere or nowhere.
 */
export const REQUIRED_SECTIONS = [
  '## 0. Quy tắc cập nhật file này (bắt buộc)',
  '## 1. Repo này là gì trong FixHome',
  '## 2. Liên kết với các repo khác',
  '## 3. Trạng thái hiện tại',
  '## 4. Kiến trúc và thư mục chính',
  '## 5. Hợp đồng với repo khác',
  '## 6. Chạy, kiểm thử và cổng chất lượng',
  '## 7. Quyết định đã chốt',
  '## 8. Việc đang dở và rủi ro đã biết',
  '## 9. Nhật ký cập nhật context',
];

export const MAX_LINES = 700;
export const MAX_LOG_ENTRIES = 40;

const STAMP = String.raw`(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \(UTC\+7\)`;
const HEADER = new RegExp(String.raw`^> Cập nhật lần cuối: ${STAMP} · Người cập nhật \(git\): ([^·]+?) · Nhánh: (\S+)$`);
const LOG_ENTRY = new RegExp(String.raw`^- ${STAMP} \| ([^|]+?) \| ([^|\s]+) \| (.{10,})$`);

/** Never in a public repository. */
const FORBIDDEN: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\bsk-[A-Za-z0-9]{16,}/, 'API key'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'cloud access key'],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i, 'URL with credentials'],
  [/\b(password|passwd|mật khẩu|secret|token|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=!@#$%^&*]{6,}/i, 'credential value'],
  [/\b(TODO|TBD|FIXME|FILL LATER|lorem ipsum)\b/i, 'placeholder (write CHƯA KIỂM CHỨNG or leave it out)'],
];
const ALLOWED_IPS = new Set(['127.0.0.1', '0.0.0.0', '10.0.2.2']);

function isValidStamp(stamp: string): boolean {
  const [date, time] = stamp.split(' ');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
    && hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 && y >= 2026;
}

export function checkContext(text: string, repoName: string): string[] {
  const problems: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  if (lines[0] !== `# Context repo ${repoName} — FixHome`) {
    problems.push(`line 1 must be "# Context repo ${repoName} — FixHome"`);
  }
  if (lines.length > MAX_LINES) problems.push(`file has ${lines.length} lines; keep it under ${MAX_LINES}`);

  const headerLine = lines.slice(0, 6).find((line) => line.startsWith('> Cập nhật lần cuối:'));
  const header = headerLine?.match(HEADER);
  if (!header) {
    problems.push('header must read "> Cập nhật lần cuối: YYYY-MM-DD HH:mm (UTC+7) · Người cập nhật (git): <git user.name> · Nhánh: <branch>" within the first 6 lines');
  } else if (!isValidStamp(header[1])) {
    problems.push(`header time ${header[1]} is not a real date and time`);
  }

  let cursor = -1;
  for (const section of REQUIRED_SECTIONS) {
    const at = lines.indexOf(section);
    if (at === -1) { problems.push(`missing section "${section}"`); continue; }
    if (at < cursor) problems.push(`section "${section}" is out of order`);
    cursor = at;
    const next = lines.findIndex((line, i) => i > at && line.startsWith('## '));
    const body = lines.slice(at + 1, next === -1 ? lines.length : next).filter((line) => line.trim());
    if (body.length === 0) problems.push(`section "${section}" is empty`);
  }
  const extra = lines.filter((line) => line.startsWith('## ') && !REQUIRED_SECTIONS.includes(line));
  for (const line of extra) problems.push(`unexpected top-level section "${line}"; use ### inside a required section`);

  const logStart = lines.indexOf(REQUIRED_SECTIONS[REQUIRED_SECTIONS.length - 1]);
  if (logStart !== -1) {
    const entries = lines.slice(logStart + 1).filter((line) => line.startsWith('- '));
    if (entries.length > MAX_LOG_ENTRIES) problems.push(`log has ${entries.length} entries; keep the newest ${MAX_LOG_ENTRIES}`);
    const parsed = entries.map((line) => ({ line, match: line.match(LOG_ENTRY) }));
    for (const { line, match } of parsed) {
      if (!match) problems.push(`log entry does not follow "- YYYY-MM-DD HH:mm (UTC+7) | <git user.name> | <branch or PR> | <what changed>": ${line}`);
      else if (!isValidStamp(match[1])) problems.push(`log entry time ${match[1]} is not a real date and time`);
    }
    const stamps = parsed.filter((p) => p.match).map((p) => p.match![1]);
    for (let i = 1; i < stamps.length; i++) {
      if (stamps[i] > stamps[i - 1]) { problems.push('log entries must be newest first'); break; }
    }
    const top = parsed[0]?.match;
    if (!top) problems.push('log must have at least one entry');
    else if (header && (top[1] !== header[1] || top[2].trim() !== header[2].trim())) {
      problems.push('the newest log entry must carry the same time and git name as the header');
    }
  }

  lines.forEach((line, i) => {
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(line)) problems.push(`line ${i + 1}: ${what} is not allowed`);
    }
    for (const ip of line.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
      if (!ALLOWED_IPS.has(ip)) problems.push(`line ${i + 1}: IP address ${ip} is not allowed`);
    }
  });
  return problems;
}

const REPO = 'backend';

describe('docs/CONTEXT.md follows its own rules', () => {
  const text = readFileSync(join(process.cwd(), 'docs', 'CONTEXT.md'), 'utf8');

  it('passes every rule in section 0', () => {
    expect(checkContext(text, REPO)).toEqual([]);
  });

  it('rejects a context that breaks the rules', () => {
    const broken = text
      .replace(/^> Cập nhật lần cuối: .*$/m, '> Cập nhật lần cuối: hôm qua')
      .replace('## 7. Quyết định đã chốt', '## 7. Ghi chú linh tinh')
      .concat('\nmật khẩu: Abc12345678\nmáy GPU ở 203.0.113.7\n- hôm nay | ai đó | nhánh | sửa linh tinh\n');
    const problems = checkContext(broken, REPO);
    expect(problems.some((p) => p.startsWith('header must read'))).toBe(true);
    expect(problems.some((p) => p.includes('missing section "## 7.'))).toBe(true);
    expect(problems.some((p) => p.includes('credential value'))).toBe(true);
    expect(problems.some((p) => p.includes('IP address 203.0.113.7'))).toBe(true);
    expect(problems.some((p) => p.startsWith('log entry does not follow'))).toBe(true);
  });
});
