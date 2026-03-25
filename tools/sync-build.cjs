const fs = require('fs');
const path = require('path');

const files = ['app.js', 'gpu_renderer.js', 'worker.js'];
for (const file of files) {
  const src = path.join(process.cwd(), 'build', file);
  const dst = path.join(process.cwd(), file);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing build output: ${src}`);
  }
  fs.copyFileSync(src, dst);
}
console.log('Synced build outputs to project root.');
