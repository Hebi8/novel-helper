import type { UsageStatus } from '../../shared/api';
import { dollars } from '../../core/usage';
import { zh } from '../strings';
export function StatusBar({ status,words,toggle }: { status: UsageStatus; words: number; toggle(): void; }) {
  return <footer className="statusbar"><button onClick={toggle} title={status.missingKey? zh.missingKey:status.problem}><span className={`status-dot ${status.state}`} />{zh.continuation} · {zh[status.state]}</button><span>{zh.today} {status.today.requests} {zh.requests} · ≈ {dollars(status.today.cost)}</span><span className="grow" /><span>{words.toLocaleString()} {zh.words}</span></footer>;
}
