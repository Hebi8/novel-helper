import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SettingsWindow } from './settings/SettingsWindow';
import { TabBar } from './shell/TabBar';
import './style.css';
const params = new URLSearchParams(location.search);
if (params.has('tabbar')) {
	document.documentElement.dataset.tabbar = 'true';
}
createRoot(document.getElementById('root')!).render(
	params.has('settings') ? <SettingsWindow /> : params.has('tabbar') ? <TabBar /> : <App />,
);
