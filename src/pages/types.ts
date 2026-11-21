import type { AppData } from '../domain';
import type { Update } from '../App';
export type Props = {
  data: AppData;
  update: Update;
  notify: (message: string) => void;
  isDemo: boolean;
};
