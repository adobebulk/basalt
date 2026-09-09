const pkg = require('../package.json');
const fs = require('fs');
fs.mkdirSync('site/data', { recursive: true });
const yaml = `version: "${pkg.version}"\n`;
fs.writeFileSync('site/data/version.yaml', yaml);
console.log(`Version: ${pkg.version}`);
