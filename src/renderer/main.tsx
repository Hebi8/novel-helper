import { createRoot } from 'react-dom/client';
import { App } from './App';
import { SettingsWindow } from './settings/SettingsWindow';
import './style.css';
createRoot(document.getElementById('root')!).render(location.search.includes('settings')? <SettingsWindow />:<App />);
