import type { TabState } from '../../shared/api';
import { zh } from '../strings';
export function Tabs({ tabs,active,select,close }: { tabs: TabState[]; active?: string; select(path: string): void; close(path: string): void; }) {
  return <nav className="tabs" role="tablist">{tabs.map(tab => <div role="tab" tabIndex={0} aria-selected={tab.path===active} key={tab.path} className={tab.path===active? 'active':''} onClick={() => select(tab.path)} onKeyDown={event => { if(event.key==='Enter') { select(tab.path); } }}><span>{tab.path.split('/').pop()!.replace(/\.(md|txt)$/,'')}</span><button aria-label={`${zh.closeTab} ${tab.path}`} onClick={event => { event.stopPropagation(); close(tab.path); }}>×</button></div>)}</nav>;
}
