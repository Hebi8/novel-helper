import * as fs from 'node:fs';
import * as path from 'node:path';

export function filesIn(dir: string,relative=''): string[] {
  if(!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir,{ withFileTypes: true })
    .sort((a,b) => (a.name<b.name? -1:1))
    .flatMap((entry) => (entry.isDirectory()? filesIn(path.join(dir,entry.name),`${relative}${entry.name}/`):[`${relative}${entry.name}`]));
}
