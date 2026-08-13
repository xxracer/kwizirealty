const fs = require('fs');
const path = require('path');

const directoryPath = path.join(__dirname, 'src');

function revertInFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let newContent = content
    // Backgrounds
    .replace(/bg-background/g, 'bg-[#0a0c10]')
    .replace(/bg-surface-elevated/g, 'bg-[#1a1f2e]')
    .replace(/bg-surface/g, 'bg-[#121620]')

    // Brand colors
    .replace(/bg-brand-hover/g, 'bg-blue-700')
    .replace(/bg-brand/g, 'bg-blue-600')
    .replace(/hover:bg-brand-hover/g, 'hover:bg-blue-500')
    .replace(/text-brand/g, 'text-blue-600')

    // Borders
    .replace(/border-border-subtle/g, 'border-white/[0.06]');

  if (content !== newContent) {
    fs.writeFileSync(filePath, newContent, 'utf8');
    console.log(`Reverted colors in ${filePath}`);
  }
}

function traverseDirectory(dir) {
  const files = fs.readdirSync(dir);
  files.forEach(file => {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      traverseDirectory(fullPath);
    } else if (fullPath.endsWith('.tsx')) {
      revertInFile(fullPath);
    }
  });
}

traverseDirectory(directoryPath);
console.log('Done reverting colors.');
