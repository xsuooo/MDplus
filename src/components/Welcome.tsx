import { useSceneMotion } from '../hooks/useSceneMotion';
import { displayPath } from '../lib/paths';
import type { RecentFile } from '../lib/types';
import { IconBrand, IconNew, IconOpen } from './icons';

/** A ruled sheet and the Markdown heading mark; shapes only, so nothing small has to stay legible. */
function WritingScene() {
  const scene = useSceneMotion();
  return (
    <div className="writing-scene" ref={scene} aria-hidden="true">
      <div className="scene-sheet">
        <span className="scene-line" />
        <span className="scene-line" />
        <span className="scene-line" />
        <span className="scene-line" />
        <span className="scene-line" />
      </div>
      <div className="scene-slab">
        <span className="scene-glyph">#</span>
      </div>
    </div>
  );
}

export function Welcome({
  recents,
  onNew,
  onOpen,
  onExample,
  onRecent,
}: {
  recents: RecentFile[];
  onNew: () => void;
  onOpen: () => void;
  onExample: () => void;
  onRecent: (path: string) => void;
}) {
  return (
    <div className="welcome welcome-studio">
      <div className="welcome-composition">
        <section className="welcome-copy" aria-labelledby="welcome-title">
          <span className="welcome-logo" aria-hidden="true">
            <IconBrand size={40} />
          </span>
          <h1 id="welcome-title">
            <span>开始写作，</span>
            <span>
              或继续文稿。
              <i className="welcome-caret" aria-hidden="true" />
            </span>
          </h1>
          <div className="welcome-actions">
            <button className="btn btn-primary" onClick={onNew}>
              <IconNew size={18} aria-hidden="true" />
              <span>新建空白文稿</span>
            </button>
            <button className="btn welcome-open" onClick={onOpen}>
              <IconOpen size={18} aria-hidden="true" />
              <span>打开文件</span>
            </button>
          </div>
          <p className="welcome-drop-hint">也可以把 Markdown 文件拖进窗口打开</p>
        </section>
        <WritingScene />
      </div>
      <div className="welcome-bottomline">
        {recents.length > 0 && (
          <section className="welcome-recents" aria-label="最近文件">
            <h2 className="welcome-recents-title">继续写作</h2>
            <div className="welcome-recent-list">
              {recents.slice(0, 5).map((file) => (
                <button
                  key={file.path}
                  className="welcome-recent-item"
                  title={displayPath(file.path)}
                  aria-label={`打开 ${file.name}，${displayPath(file.path)}`}
                  onClick={() => onRecent(file.path)}
                >
                  <span className="welcome-recent-name">{file.name}</span>
                  <span className="welcome-recent-path">
                    {displayPath(file.path).replace(/[^\\/]+$/, '')}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
        <button className="welcome-example" onClick={onExample}>
          打开示例文档
        </button>
      </div>
    </div>
  );
}
