import { Component, type ReactNode } from 'react';
import { showInitialWindow } from '../services/windowPersistence';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** 错误边界:捕获渲染异常,避免整棵 React 树崩溃白屏 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('MDPlus 渲染异常:', error);
    void showInitialWindow();
  }

  render() {
    if (this.state.error) {
      return (
        <div className="welcome error-state" role="alert">
          <h2>编辑器暂时无法显示</h2>
          <p>重新加载可能丢失尚未保存的更改；已有恢复副本可在重新打开后找回。</p>
          <details className="error-details">
            <summary>错误详情</summary>
            <pre>{this.state.error.message}</pre>
          </details>
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
