import { Component, type ReactNode } from 'react';

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
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
          }}
        >
          <h2 style={{ margin: 0 }}>出了点问题</h2>
          <p style={{ maxWidth: 480, wordBreak: 'break-all', fontSize: 13, opacity: 0.7 }}>
            {this.state.error.message}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 18px',
              borderRadius: 6,
              border: '1px solid currentColor',
              background: 'transparent',
              cursor: 'pointer',
            }}
          >
            重新加载
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
