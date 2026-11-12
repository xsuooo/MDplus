import { Fragment, Slice, type Node } from '@milkdown/prose/model';
import { Selection, SelectionRange, type SelectionBookmark } from '@milkdown/prose/state';
import type { Mappable } from '@milkdown/prose/transform';

/** Separate image ranges keep text and other images outside a marquee untouched. */
export class ImageSelection extends Selection {
  visible = false;

  private constructor(
    doc: Node,
    readonly positions: readonly number[],
  ) {
    super(
      doc.resolve(positions[0]),
      doc.resolve(positions[positions.length - 1] + 1),
      positions.map((pos) => new SelectionRange(doc.resolve(pos), doc.resolve(pos + 1))),
    );
  }

  static create(doc: Node, positions: readonly number[], fallback = 0): Selection {
    const valid = [...new Set(positions)]
      .filter(
        (pos) =>
          Number.isInteger(pos) &&
          pos >= 0 &&
          pos < doc.content.size &&
          doc.nodeAt(pos)?.type.name === 'image',
      )
      .sort((a, b) => a - b);
    return valid.length
      ? new ImageSelection(doc, valid)
      : Selection.near(doc.resolve(Math.max(0, Math.min(doc.content.size, fallback))));
  }

  eq(other: Selection): boolean {
    return (
      other instanceof ImageSelection &&
      other.positions.length === this.positions.length &&
      this.positions.every((pos, index) => pos === other.positions[index])
    );
  }

  map(doc: Node, mapping: Mappable): Selection {
    return this.getBookmark().map(mapping).resolve(doc);
  }

  content(): Slice {
    return new Slice(
      Fragment.fromArray(this.positions.map((pos) => this.$anchor.doc.nodeAt(pos)!)),
      0,
      0,
    );
  }

  toJSON() {
    return { type: 'mdplus-images', positions: this.positions };
  }

  static fromJSON(doc: Node, json: { positions?: unknown }): Selection {
    if (
      !Array.isArray(json?.positions) ||
      !json.positions.length ||
      !json.positions.every(
        (pos) =>
          Number.isInteger(pos) &&
          pos >= 0 &&
          pos < doc.content.size &&
          doc.nodeAt(pos)?.type.name === 'image',
      )
    )
      throw new RangeError('Invalid image selection');
    return ImageSelection.create(doc, json.positions);
  }

  getBookmark(): SelectionBookmark {
    const bookmark = (positions: readonly number[], fallback: number): SelectionBookmark => ({
      map(mapping) {
        return bookmark(
          positions.flatMap((pos) => {
            const next = mapping.mapResult(pos, 1);
            return next.deleted ? [] : [next.pos];
          }),
          mapping.map(fallback),
        );
      },
      resolve: (doc) => ImageSelection.create(doc, positions, fallback),
    });
    return bookmark(this.positions, this.anchor);
  }
}

Selection.jsonID('mdplus-images', ImageSelection);
