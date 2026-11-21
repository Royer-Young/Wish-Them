import { Download } from 'lucide-react';
import { emptyData, settlement } from '../domain';
import { go, Heading, Mascot, Paper, WishCard } from '../components';
import type { Props } from './types';

export function Mine({ data, update, notify }: Props) {
  function exportData() {
    const payload = {
      version: data.version,
      wish: data.wish
        ? {
            name: data.wish.name,
            text: data.wish.text,
            relation: data.wish.relation,
            start: data.wish.start,
            status: data.wish.status,
          }
        : null,
      ledger: data.ledger,
      records: data.checkins.map((c) => ({ note: c.note, at: c.at })),
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = '愿TA-心意记录.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="page">
      <Heading eyebrow="YOUR OWN LITTLE POSTBOX" title="你的心意，都好好收在这里" />
      <div className="two-column">
        <Paper>
          <h2>我的愿签</h2>
          {data.wish ? (
            <>
              <WishCard wish={data.wish} />
              <div className="button-row">
                <button className="primary" onClick={() => go('/today')}>
                  查看今天的小事
                </button>
                {settlement(data).due && (
                  <button className="secondary" onClick={() => go('/settle')}>
                    查看约定结果
                  </button>
                )}
              </div>
            </>
          ) : (
            <>
              <p>还没有愿签。第一份心意，会寄给谁呢？</p>
              <button className="primary" onClick={() => go('/start')}>
                替TA许个愿
              </button>
            </>
          )}
        </Paper>
        <Paper>
          <h2>关于这间本机邮局</h2>
          <p>愿签、照片、问答与账本保存在当前浏览器。更换设备或清除浏览器数据后无法自动找回。</p>
          <p>基础版尚未连接云账号、公开发布或AI服务。不会把你的照片与问答发到服务器。</p>
          <button className="secondary full" onClick={exportData}>
            <Download size={16} />
            导出文字记录
          </button>
          <p className="muted">导出不含私人问答和照片，不可用于跨设备恢复。</p>
          <button
            className="text-button danger"
            onClick={async () => {
              if (window.confirm('删除本机全部愿签、问答、照片和账本？此操作无法撤回。')) {
                try {
                  await update(() => emptyData());
                  notify('本机数据已清空。');
                  go('/');
                } catch {
                  notify('清空失败，请重试。');
                }
              }
            }}
          >
            清空本机数据
          </button>
          <Mascot small message="心意不必很大，但每一份都值得认真。" />
        </Paper>
      </div>
    </div>
  );
}
