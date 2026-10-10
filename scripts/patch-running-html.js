const fs = require('fs');
const path = require('path');

const files = [
  path.join(__dirname, '..', 'out', 'RunContainer-win32-x64', 'resources', 'app', 'build', 'index.html'),
  path.join(__dirname, '..', 'build', 'index.html'),
];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace('/static/css/main.a1f5b09c.chunk.css', './static/css/main.a1f5b09c.chunk.css');
  content = content.replace('/static/js/2.9ec93c67.chunk.js', './static/js/2.9ec93c67.chunk.js');
  content = content.replace('/static/js/main.6874bf70.chunk.js', './static/js/main.6874bf70.chunk.js');
  content = content.replace('i.p="/"', 'i.p="./"');
  fs.writeFileSync(file, content, 'utf8');
  console.log(`PATCHED ${file}`);
}
