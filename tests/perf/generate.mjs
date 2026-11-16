import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

export const fixtureNames = ['table-1200', 'long-5000', 'images-20'];
const directory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function png(index) {
  const width = 96;
  const height = 64;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      pixels[offset] = (x * 7 + index * 13) % 256;
      pixels[offset + 1] = (y * 11 + index * 17) % 256;
      pixels[offset + 2] = (x + y + index * 23) % 256;
      pixels[offset + 3] = 255;
    }
  }
  const chunk = (name, bytes) => {
    const data = Buffer.concat([Buffer.from(name), bytes]);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(data));
    return Buffer.concat([header, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Deterministic synthetic documents only; never read or copy a user's document. */
export async function generateFixtures() {
  const table = [
    '# Fixed 1200-row table',
    '',
    'Before table marker.',
    '',
    '| Name | Number | Notes | Code | Status |',
    '| :--- | ---: | :---: | --- | --- |',
    ...Array.from(
      { length: 1200 },
      (_, index) => `| Row ${index} | ${index} | 中文 cell-${index} | \`value_${index}\` | Ready |`,
    ),
    '',
    'After table marker.',
    '',
    'PERF_INPUT_TARGET',
    '',
  ].join('\n');
  const long =
    [
      ...Array.from({ length: 4998 }, (_, index) =>
        index % 2
          ? ''
          : `Paragraph ${String(index / 2 + 1).padStart(4, '0')}. 中文性能测量固定文本。 ` +
            'The document preserves paragraphs, punctuation, and ordinary Markdown emphasis. '.repeat(
              4,
            ),
      ),
      'PERF_INPUT_TARGET',
      '',
    ].join('\n') + '\n';
  const images = [
    '# Fixed 20-image document',
    '',
    ...Array.from({ length: 20 }, (_, index) => {
      const number = String(index + 1).padStart(2, '0');
      return [
        `## Image ${number}`,
        '',
        `![Synthetic image ${number}](images/image-${number}.png)`,
        '',
        `Image ${number} belongs only to this generated benchmark. 中文图片说明。`,
        '',
      ].join('\n');
    }),
    'PERF_INPUT_TARGET',
    '',
  ].join('\n');
  assert.equal(table.match(/^\| Row /gm)?.length, 1200);
  assert.equal(long.split('\n').length - 1, 5000);
  assert.equal(images.match(/^!\[/gm)?.length, 20);
  const entries = [
    ['table-1200.md', Buffer.from(table)],
    ['long-5000.md', Buffer.from(long)],
    ['images-20.md', Buffer.from(images)],
    ...Array.from({ length: 20 }, (_, index) => [
      `images/image-${String(index + 1).padStart(2, '0')}.png`,
      png(index),
    ]),
  ];
  const manifest = [];
  for (const [name, bytes] of entries) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    const previous = await readFile(path).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (!previous?.equals(bytes)) await writeFile(path, bytes);
    manifest.push({
      name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  assert.equal(new Set(manifest.slice(3).map((entry) => entry.sha256)).size, 20);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(JSON.stringify(await generateFixtures(), null, 2));
}
