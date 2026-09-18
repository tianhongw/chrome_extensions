// YAML front matter: `---` on the very first line, closed by `---` or `...`.
const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const TITLE_RE = /^title:[ \t]*(.+?)[ \t]*$/m;

export function splitFrontMatter(source) {
  const match = FRONT_MATTER_RE.exec(source);
  if (!match) return { frontMatter: null, body: source };
  return { frontMatter: match[1], body: source.slice(match[0].length) };
}

export function frontMatterTitle(frontMatter) {
  const value = frontMatter && TITLE_RE.exec(frontMatter)?.[1];
  return value ? value.replace(/^(['"])(.*)\1$/, '$2') : null;
}
