import { describe, expect, it } from 'vitest';
import { Schema } from '@milkdown/prose/model';
import { EditorState } from '@milkdown/prose/state';
import { imageLayoutPlugin } from '../src/lib/imageLayout';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', group: 'block' },
    image: { inline: true, group: 'inline', attrs: { src: { default: 'image.png' } } },
    hardbreak: { inline: true, group: 'inline' },
    text: { group: 'inline' },
  },
});

describe('standalone image layout', () => {
  const image = () => schema.node('image');
  const paragraph = (...content: ReturnType<typeof image>[]) => schema.node('paragraph', null, content);
  const state = (...content: ReturnType<typeof image>[]) => EditorState.create({
    doc: schema.node('doc', null, content), plugins: [imageLayoutPlugin],
  });
  const centered = (current: EditorState) => imageLayoutPlugin.getState(current)!.find().length;

  it('centers standalone and consecutive images without changing document data', () => {
    const current = state(paragraph(image(), schema.text(' '), schema.node('hardbreak'), image()));
    const before = current.doc.toJSON();
    expect(centered(current)).toBe(1);
    expect(current.doc.toJSON()).toEqual(before);
  });

  it('does not center empty paragraphs or inline images surrounded by text', () => {
    expect(centered(state(paragraph(), paragraph(image(), schema.text(' caption'))))).toBe(0);
  });

  it('updates alignment when text is typed into or removed from an image paragraph', () => {
    let current = state(paragraph(image()));
    expect(centered(current)).toBe(1);
    current = current.apply(current.tr.insertText('text ', 1));
    expect(centered(current)).toBe(0);
    current = current.apply(current.tr.delete(1, 6));
    expect(centered(current)).toBe(1);
  });
});
