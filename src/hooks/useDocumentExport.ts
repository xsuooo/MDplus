import { useCallback, useRef, useState } from 'react';
import { showMessage } from '../lib/dialog';
import { flushEditorUpdate } from '../lib/editorUpdates';
import { type BodyFont, type CodeFont } from '../lib/editorFont';
import { errorMessage } from '../lib/errors';
import { assertExportBytes, captureExport, exportHTML, exportPDF } from '../lib/export';
import { capturePendingImages, type PendingImageLease } from '../lib/imageOps';
import { getImageUrls } from '../lib/imagePaths';

import type { Workspace } from './useWorkspace';
import type { RecoveryController } from './useRecovery';

export function useDocumentExport(
  workspace: Workspace,
  recovery: RecoveryController,
  bodyFont: BodyFont,
  codeFont: CodeFont,
) {
  const { activeTab, tabRuntime, tabsRef, resolveContent } = workspace;
  const { prepareCurrentImages } = recovery;
  const [exporting, setExporting] = useState(false);
  const exportBusy = useRef(false);
  /* ---------- 导出功能 ---------- */
  const handleExport = useCallback(
    async (format: 'html' | 'pdf') => {
      if (!activeTab || exportBusy.current) return;
      exportBusy.current = true;
      setExporting(true);
      let images: PendingImageLease | undefined;
      try {
        const pendingEditor = tabRuntime.current[activeTab.id]?.editor;
        if (pendingEditor) flushEditorUpdate(pendingEditor);
        await tabRuntime.current[activeTab.id]?.saveQueue;
        const tab = tabsRef.current.find((candidate) => candidate.id === activeTab.id);
        const editor = tabRuntime.current[activeTab.id]?.editor;
        if (!tab || !editor) throw new Error('编辑器尚未就绪，请稍后重试');
        const content = resolveContent(tab),
          version = tabRuntime.current[tab.id]?.contentVersion ?? 0;
        const imagesReady = await prepareCurrentImages(tab.id);
        const current = tabsRef.current.find((candidate) => candidate.id === tab.id);
        if (
          !imagesReady ||
          !current ||
          current.path !== tab.path ||
          current.diskRevision !== tab.diskRevision ||
          (tabRuntime.current[tab.id]?.contentVersion ?? 0) !== version ||
          resolveContent(current) !== content
        ) {
          throw new Error('图片准备期间文稿已变化，请重新导出');
        }
        images = capturePendingImages(tab.id, getImageUrls(content));
        const sources: string[] = [];
        // Parse before the first hydration await: later edits/Save As must not
        // change the schema's live URL-to-token mapping for this frozen export.
        const snapshot = captureExport(
          editor,
          content,
          tab.title || '未命名',
          bodyFont,
          codeFont,
          (src) => {
            sources.push(src);
            return 'data:,';
          },
        );
        const imageSizes = new Map<string, number>();
        for (const image of images.images) {
          const size = Math.ceil(image.byteLength / 3) * 4 + `data:${image.mime};base64,`.length;
          imageSizes.set(image.placeholder, size);
          if (image.source) imageSizes.set(image.source.url, size);
        }
        assertExportBytes(
          sources.reduce((bytes, src) => bytes + (imageSizes.get(src) ?? src.length), 0),
        );
        const embedded = new Map<string, string>();
        for (const image of images.images) {
          await images.withDataBase64(image.placeholder, async (dataBase64) => {
            const src = `data:${image.mime};base64,${dataBase64}`;
            embedded.set(image.placeholder, src);
            if (image.source) embedded.set(image.source.url, src);
          });
        }
        snapshot.content.querySelectorAll('img').forEach((image, index) => {
          const source = sources[index];
          image.src = embedded.get(source) ?? source;
        });
        if (format === 'html') {
          if (await exportHTML(snapshot)) await showMessage('HTML 导出成功', 'info');
        } else await exportPDF(snapshot);
      } catch (err) {
        console.error('导出失败', err);
        await showMessage(`导出失败: ${errorMessage(err)}`, 'error');
      } finally {
        images?.release();
        exportBusy.current = false;
        setExporting(false);
      }
    },
    [activeTab, tabRuntime, tabsRef, resolveContent, prepareCurrentImages, bodyFont, codeFont],
  );
  const handleExportHTML = useCallback(() => handleExport('html'), [handleExport]);
  const handleExportPDF = useCallback(() => handleExport('pdf'), [handleExport]);

  return { exporting, handleExportHTML, handleExportPDF };
}
