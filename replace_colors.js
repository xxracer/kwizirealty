const fs = require('fs');
const path = require('path');

const directoryPath = path.join(__dirname, 'src');

function replaceInFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let newContent = content
    // Backgrounds
    .replace(/bg-\[\#0a0c10\]/g, 'bg-background')
    .replace(/bg-\[\#0d1117\]/g, 'bg-surface')
    .replace(/bg-\[\#0e1117\]/g, 'bg-surface')
    .replace(/bg-\[\#121620\]/g, 'bg-surface')
    .replace(/bg-\[\#1a1f2e\]/g, 'bg-surface-elevated')
    .replace(/bg-\[\#0f121a\]/g, 'bg-background') // map page summary bar & sidebar

    // Brand colors
    .replace(/bg-blue-600/g, 'bg-brand')
    .replace(/hover:bg-blue-500/g, 'hover:bg-brand-hover')
    .replace(/hover:bg-blue-700/g, 'hover:bg-brand-hover')
    .replace(/text-blue-600/g, 'text-brand')

    // Borders
    .replace(/border-white\/\[0\.06\]/g, 'border-border-subtle')
    .replace(/border-white\/\[0\.08\]/g, 'border-border-subtle')
    .replace(/border-white\/10/g, 'border-border-subtle')
    .replace(/border-white\/5/g, 'border-border-subtle')
    .replace(/border-\[\#374151\]/g, 'border-border-subtle');

  if (content !== newContent) {
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log(`Updated ${filePath}`);
  }
}

function traverseDirectory(dir) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      traverseDirectory(fullPath);
    } else if (fullPath.endsWith('.tsx')) {
      replaceInFile(fullPath);
    }
  });
}

traverseDirectory(directoryPath);
console.log('Done replacing colors.');
