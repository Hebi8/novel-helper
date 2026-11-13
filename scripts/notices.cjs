const fs = require('node:fs');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const packages = Object.entries(lock.packages).filter(([folder, entry]) => folder && !entry.dev).map(([folder, entry]) => ({ folder, title: `${folder.slice('node_modules/'.length)} ${entry.version}` })).sort((a, b) => a.title < b.title ? -1 : 1);
fs.writeFileSync('THIRD-PARTY-NOTICES.md', '# Third-party notices\n\nPackages distributed with Novel Helper and their licenses.\n\n' + packages.map(({folder, title}) => `## ${title}\n\n\`\`\`text\n${fs.readFileSync(`${folder}/LICENSE`, 'utf8').trimEnd()}\n\`\`\`\n`).join('\n'));
