/// <reference types="vite/client" />
import type { AppAPI } from '../shared/api';
declare global { interface Window { novel: AppAPI; } }
