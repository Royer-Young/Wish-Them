import { Mail, LockKeyhole, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { Wish } from './domain';
export const go = (path: string) => {
  window.location.hash = path;
  window.scrollTo(0, 0);
};
export function Mascot({
  message = '慢慢来，心意会被好好收下。',
  small = false,
}: {
  message?: string;
  small?: boolean;
}) {
  return (
    <div className={`mascot ${small ? 'small' : ''}`}>
      <p className="speech">{message}</p>
      <img src="/assets/xiaoyuan.png" alt="小愿，穿砖红背带裙、拿着信封的邮局女孩" />
    </div>
  );
}
export function Paper({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`paper ${className}`}>{children}</section>;
}
export function WishCard({ wish }: { wish: Pick<Wish, 'name' | 'text' | 'ai'> }) {
  return (
    <div className="wish-card">
      <Mail size={28} aria-hidden="true" />
      <span className="eyebrow">一封认真收藏的心意</span>
      <h2>替{wish.name}许愿</h2>
      <p>{wish.text}</p>
      {wish.ai && (
        <span className="tag">
          <Sparkles size={13} /> AI辅助
        </span>
      )}
      <div className="wish-sign">愿每一份心意，都慢慢靠近。</div>
    </div>
  );
}
export function PrivateNote() {
  return (
    <span className="private">
      <LockKeyhole size={14} aria-hidden="true" /> 愿签默认私密，由你决定是否分享
    </span>
  );
}
export function Heading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <header className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <span className="postmark">
        暖木邮局
        <br />
        心意已收好
      </span>
    </header>
  );
}
