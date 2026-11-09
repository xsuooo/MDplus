// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Fragment, Schema, Slice } from '@milkdown/prose/model';
import { EditorState, Selection, TextSelection } from '@milkdown/prose/state';
import { history, undo } from '@milkdown/prose/history';
import { ImageSelection } from '../src/lib/imageSelection';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    image: {
      inline: true,
      group: 'inline',
      attrs: { src: {} },
      toDOM: (node) => ['img', { src: node.attrs.src }],
    },
  },
});
function fixture() {
  const paragraph = (text: string, src: string) =>
    schema.node('paragraph', null, [schema.text(text), schema.node('image', { src })]);
  const doc = schema.node('doc', null, [
    paragraph('First ', 'one.png'),
    paragraph('Keep this text ', 'two.png'),
    paragraph('Last ', 'three.png'),
  ]);
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'image') positions.push(pos);
  });
  return { doc, positions, selection: ImageSelection.create(doc, [positions[0], positions[2]]) };
}
describe('rectangular image selection', () => {
  it('copies only the image ranges and restores the selection from JSON', () => {
    const { doc, positions, selection } = fixture();
    expect(selection).toBeInstanceOf(ImageSelection);
    expect(selection.visible).toBe(false);
    expect(selection.ranges.map((range) => range.$from.pos)).toEqual([positions[0], positions[2]]);
    const content = selection.content();
    expect(content.content.childCount).toBe(2);
    expect(content.content.firstChild!.attrs.src).toBe('one.png');
    expect(content.content.lastChild!.attrs.src).toBe('three.png');
    expect(content.content.textBetween(0, content.content.size)).toBe('');
    expect(
      Selection.fromJSON(doc, JSON.parse(JSON.stringify(selection.toJSON()))).eq(selection),
    ).toBe(true);
  });
  it('deletes and undoes disjoint images without deleting the intervening text or image', () => {
    const { doc, selection } = fixture();
    let state = EditorState.create({ doc, selection, plugins: [history()] });
    state = state.apply(state.tr.deleteSelection());
    expect(state.doc.textContent).toBe(doc.textContent);
    const images: string[] = [];
    state.doc.descendants((node) => {
      if (node.type.name === 'image') images.push(node.attrs.src);
    });
    expect(images).toEqual(['two.png']);
    expect(
      undo(state, (transaction) => {
        state = state.apply(transaction);
      }),
    ).toBe(true);
    expect(state.doc.eq(doc)).toBe(true);
    expect(state.selection.eq(selection)).toBe(true);
  });
  it('replaces selected images once when typing or pasting', () => {
    const { doc, selection } = fixture();
    const state = EditorState.create({ doc, selection });
    const typed = state.tr.insertText('Replacement');
    expect(typed.doc.textContent).toBe('First ReplacementKeep this text Last ');
    const pasted = state.tr.replaceSelection(
      new Slice(Fragment.from(schema.node('image', { src: 'new.png' })), 0, 0),
    );
    const images: string[] = [];
    pasted.doc.descendants((node) => {
      if (node.type.name === 'image') images.push(node.attrs.src);
    });
    expect(images).toEqual(['new.png', 'two.png']);
    expect(pasted.doc.textContent).toBe(doc.textContent);
  });
  it('maps edits and removed images without selecting replacement text', () => {
    const { doc, positions, selection } = fixture();
    const state = EditorState.create({ doc, selection });
    const inserted = state.tr.insertText('New ', 1);
    expect((selection.map(inserted.doc, inserted.mapping) as ImageSelection).positions).toEqual([
      positions[0] + 4,
      positions[2] + 4,
    ]);
    const removed = state.tr.delete(positions[0], positions[0] + 1);
    expect((selection.map(removed.doc, removed.mapping) as ImageSelection).positions).toEqual([
      positions[2] - 1,
    ]);
    const replaced = state.tr
      .insertText('text', positions[0], positions[0] + 1)
      .insertText('text', positions[2] + 3, positions[2] + 4);
    expect(selection.map(replaced.doc, replaced.mapping)).toBeInstanceOf(TextSelection);
  });
  it('rejects invalid serialized positions and safely resolves a stale bookmark', () => {
    const { doc, selection } = fixture();
    for (const positions of [[], [1], [-1], [1.5], ['7'], [Infinity], [doc.content.size + 1]])
      expect(() => ImageSelection.fromJSON(doc, { positions })).toThrow('Invalid image selection');
    const empty = schema.node('doc', null, [schema.node('paragraph')]);
    expect(selection.getBookmark().resolve(empty)).toBeInstanceOf(TextSelection);
  });
});
