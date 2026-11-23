import { useSceneMotion } from '../hooks/useSceneMotion';
import { displayPath } from '../lib/paths';
import type { RecentFile } from '../lib/types';
import { IconBrand, IconNew, IconOpen } from './icons';

function WritingScene() {
  const scene = useSceneMotion();
  return (
    <div className="writing-scene" ref={scene} aria-hidden="true">
      <div className="scene-grid" />
      <div className="scene-orbit" />
      <span className="scene-registration scene-registration-top">+</span>
      <span className="scene-registration scene-registration-bottom">+</span>
      <div className="scene-backplate" />
      <div className="scene-sheet">
        <div className="scene-sheet-head">
          <span>MDPLUS</span>
          <span>FIELD NOTES — 01</span>
        </div>
        <div className="scene-type">
          Aa<span>+</span>
        </div>
        <div className="scene-sheet-rule" />
        <div className="scene-sheet-copy">
          把想法，
          <br />
          写成可能。
        </div>
        <div className="scene-sheet-foot">
          <span>A SPACE FOR YOUR WORDS</span>
          <span>↗</span>
        </div>
        <div className="scene-glint" />
      </div>
      <div className="scene-note">
        <span>纯粹书写</span>
        <span>MARKDOWN, REIMAGINED.</span>
      </div>
      <span className="scene-coordinate">LOCAL. QUIET. YOURS.</span>
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
      <div className="welcome-topline" aria-hidden="true">
        <span>YOUR WRITING ROOM</span>
        <span>一个只属于文字的空间</span>
      </div>
      <div className="welcome-composition">
        <section className="welcome-copy" aria-labelledby="welcome-title">
          <div className="welcome-eyebrow">
            <span className="welcome-logo" aria-hidden="true">
              <IconBrand size={22} />
            </span>
            <span>MDPLUS / 开始写作</span>
          </div>
          <h1 id="welcome-title">
            每个想法，
            <br />
            <span>值得落笔。</span>
          </h1>
          <p className="welcome-description">
            从一行文字开始。
            <br />
            专注表达，其余交给这个安静的写作空间。
          </p>
          <div className="welcome-actions">
            <button className="btn btn-primary" onClick={onNew}>
              <IconNew size={17} aria-hidden="true" />
              <span>新建文档</span>
              <span className="welcome-action-arrow" aria-hidden="true">
                ↗
              </span>
            </button>
            <button className="btn welcome-open" onClick={onOpen}>
              <IconOpen size={17} aria-hidden="true" />
              <span>打开文件</span>
            </button>
          </div>
          <p className="welcome-drop-hint">
            <span className="welcome-drop-line" aria-hidden="true" />
            也可以把 Markdown 文件拖进窗口打开
          </p>
        </section>
        <WritingScene />
      </div>
      <div className="welcome-bottomline">
        {recents.length > 0 ? (
          <section className="welcome-recents" aria-label="最近打开">
            <div className="welcome-recents-title">
              <span>继续上次的思绪</span>
              <span aria-hidden="true">RECENT DOCUMENTS</span>
            </div>
            <div className="welcome-recent-list">
              {recents.slice(0, 5).map((file) => (
                <button
                  key={file.path}
                  className="welcome-recent-item"
                  title={displayPath(file.path)}
                  aria-label={`${file.name}，${displayPath(file.path)}`}
                  onClick={() => onRecent(file.path)}
                >
                  <span className="welcome-recent-name">{file.name}</span>
                  <span className="welcome-recent-path">
                    {displayPath(file.path).replace(/[^\\/]+$/, '')}
                  </span>
                  <span className="welcome-recent-arrow" aria-hidden="true">
                    ↗
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <p className="welcome-footnote">
            <span aria-hidden="true">✳</span> 不必准备好，开始就好。
          </p>
        )}
        <button className="welcome-example" onClick={onExample}>
          <span>先看看示例文档</span>
          <span aria-hidden="true">↗</span>
        </button>
      </div>
    </div>
  );
}
