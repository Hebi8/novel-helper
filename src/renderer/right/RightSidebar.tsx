import { OutlinePanel } from './OutlinePanel';
import { LorePanel } from './LorePanel';
import { AssistantPanel } from './AssistantPanel';
import { zh } from '../strings';
export function RightSidebar({ section,select }: { section: number; select(i: number): void; }) {
  return <aside className="sidebar right"><nav className="segments" aria-label={zh.right}>{[zh.readOutline,zh.readLore,zh.assistant].map((label,i) => <button key={label} aria-pressed={section===i} onClick={() => select(i)}>{label}</button>)}</nav>{section===0? <OutlinePanel />:section===1? <LorePanel />:<AssistantPanel />}</aside>;
}
