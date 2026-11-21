import { useEffect, useRef, useState } from 'react';
import { Mail, BookOpen, Sun, Waves, UserRound, X, Leaf } from 'lucide-react';
import { emptyData, demoData, type AppData } from './domain';
import { loadData, saveData } from './storage';
import { go } from './components';
import { Home, Today, Ledger, Pool, Mine, Settle } from './pages';
import Create from './Create';
export type Update = (fn: (data: AppData) => AppData) => Promise<void>;
export default function App() {
  const [route, setRoute] = useState(
    location.hash.slice(1) ||
      (location.pathname.startsWith('/demo') || location.search.includes('demo=1') ? '/demo' : '/'),
  );
  const [data, setData] = useState<AppData | null>(null),
    [demo, setDemo] = useState<AppData | null>(null),
    [error, setError] = useState(''),
    [toast, setToast] = useState('');
  const stateRef = useRef<AppData | null>(null),
    queue = useRef(Promise.resolve());
  useEffect(() => {
    loadData()
      .then((d) => {
        stateRef.current = d;
        setData(d);
      })
      .catch(() => setError('本机储存无法打开，请允许浏览器储存后刷新。'));
    const onHash = () => setRoute(location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    if (route === '/demo') {
      setDemo(demoData());
      go('/today');
    }
  }, [route]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(''), 3500);
      return () => clearTimeout(id);
    }
  }, [toast]);
  const update: Update = (fn) => {
    if (demo) {
      setDemo((d) => fn(d!));
      return Promise.resolve();
    }
    const operation = queue.current.then(async () => {
      const next = fn(stateRef.current!);
      await saveData(next);
      stateRef.current = next;
      setData(next);
    });
    queue.current = operation.catch(() => {
      setError('保存失败，数据尚未写入本机。请检查浏览器储存空间后重试。');
    });
    return operation;
  };
  const active = demo || data;
  const pageProps = { data: active || emptyData(), update, notify: setToast, isDemo: !!demo };
  const nav = [
    ['/', '邮局首页', Mail],
    ['/today', '今日', Sun],
    ['/pool', '愿签池', Waves],
    ['/ledger', '账本', BookOpen],
    ['/me', '我的', UserRound],
  ] as const;
  let content;
  if (!active) content = <div className="loading">{error || '正在打开暖木邮局…'}</div>;
  else
    switch (route) {
      case '/':
        content = <Home {...pageProps} />;
        break;
      case '/start':
        content = <Create {...pageProps} />;
        break;
      case '/today':
        content = <Today {...pageProps} />;
        break;
      case '/ledger':
        content = <Ledger {...pageProps} />;
        break;
      case '/pool':
        content = <Pool {...pageProps} />;
        break;
      case '/me':
        content = <Mine {...pageProps} />;
        break;
      case '/settle':
        content = <Settle {...pageProps} />;
        break;
      case '/demo':
        content = <div className="loading">正在准备演示…</div>;
        break;
      default:
        content = (
          <div className="empty">
            <h1>这封信还没有寄到这里</h1>
            <button onClick={() => go('/')}>回邮局首页</button>
          </div>
        );
    }
  return (
    <>
      <a
        className="skip"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        跳到主要内容
      </a>
      <header className="topbar">
        <a href="#/" className="brand" aria-label="愿TA 邮局首页">
          <Mail strokeWidth={1.8} />
          <strong>愿TA</strong>
          <span>暖木愿望邮局</span>
        </a>
        <nav aria-label="主要导航">
          {nav.map(([path, label, Icon]) => (
            <a
              key={path}
              href={`#${path}`}
              className={route === path ? 'active' : ''}
              aria-current={route === path ? 'page' : undefined}
            >
              <Icon size={17} />
              {label}
            </a>
          ))}
        </nav>
        <span className="header-note">
          <Leaf size={16} /> 把心意带到现实
        </span>
      </header>
      {demo && (
        <div className="demo-bar">
          <span>独立演示 · 不影响你的愿签</span>
          <div>
            <select
              aria-label="演示结局"
              onChange={(e) => setDemo(demoData(e.target.value as 'full' | 'cyber' | 'unfinished'))}
            >
              <option value="full">双重兑现</option>
              <option value="cyber">赛博实现</option>
              <option value="unfinished">未完成</option>
            </select>
            <button onClick={() => go('/settle')}>查看两幕结算</button>
            <button
              onClick={() => {
                setDemo(null);
                go('/');
              }}
            >
              退出演示
            </button>
          </div>
        </div>
      )}
      <main id="main-content" tabIndex={-1}>
        {content}
      </main>
      <footer className="site-footer">
        <span>愿TA · 暖木愿望邮局</span>
        <span>本机保存 · 照片与问答仅自己可见</span>
        <span>每一件小事，都算数。</span>
      </footer>
      {toast && (
        <div className="toast" role="status">
          <Mail size={18} />
          {toast}
        </div>
      )}
      {error && active && (
        <div className="error-banner" role="alert">
          {error}
          <button aria-label="关闭错误提示" onClick={() => setError('')}>
            <X size={16} />
          </button>
        </div>
      )}
    </>
  );
}
