/** Conservative CJK wrapping; physical font/layout still needs device validation. */
export function paginate(text: string, columns = 20, rows = 5): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = '', width = 0;
    const segments = new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(paragraph);
    for (const { segment } of segments) {
      const cells = /[^\x00-\x7f]/.test(segment) ? 2 : 1;
      if (width + cells > columns * 2 && line) { lines.push(line); line = ''; width = 0; }
      line += segment; width += cells;
    }
    lines.push(line);
  }
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows).join('\n'));
  return pages.length ? pages : [''];
}
export const isShort = (text: string) => Array.from(text.trim()).length <= 60;
