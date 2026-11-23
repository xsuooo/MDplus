import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

describe('image module import direction', () => {
  it.each([
    './references',
    './references.ts',
    './references.tsx',
    './references.js',
    './references.mjs',
  ])('rejects the stash back edge to %s with the project ESLint config', async (specifier) => {
    const [result] = await eslint.lintText(
      `import { isSamePath } from '${specifier}'; void isSamePath;`,
      {
        filePath: 'src/lib/images/stash.ts',
      },
    );

    expect(result.fatalErrorCount).toBe(0);
    expect(result.messages).toEqual([
      expect.objectContaining({ ruleId: 'no-restricted-imports', severity: 2 }),
    ]);
  });

  it.each([
    {
      filePath: 'src/lib/images/references.ts',
      code: "import { isSamePath } from './stash'; void isSamePath;",
    },
    {
      filePath: 'src/lib/images/stash.ts',
      code: "import type { FileBacking } from './cache'; export type Backing = FileBacking;",
    },
    {
      filePath: 'src/lib/images/migration.ts',
      code: "import type { PreparedImageReferences } from './references'; export type References = PreparedImageReferences;",
    },
  ])('allows the import outside the prohibited edge in $filePath', async ({ filePath, code }) => {
    const [result] = await eslint.lintText(code, { filePath });

    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });
});
