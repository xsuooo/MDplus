import type { Plugin } from 'postcss';

/** WebView2 supports WOFF2; keep KaTeX's faces without bundling legacy duplicates. */
export function katexWoff2(): Plugin {
  return {
    postcssPlugin: 'mdplus-katex-woff2',
    Once(root) {
      const file = root.source?.input.file?.replaceAll('\\', '/').split('?')[0];
      if (!file || !/\/katex\/dist\/katex(?:\.min)?\.css$/.test(file)) return;

      root.walkAtRules('font-face', (rule) => {
        rule.walkDecls('src', (declaration) => {
          const sources = declaration.value
            .split(',')
            .filter((source) => /\.woff2["']?\)\s*format\(["']woff2["']\)/.test(source));
          if (sources.length !== 1) {
            throw declaration.error('Expected exactly one WOFF2 source for each KaTeX face');
          }
          declaration.value = sources[0].trim();
        });
      });
    },
  };
}
