const pkg = require('../package.json');
const fs = require('fs');
const yaml = `version: "${pkg.version}"\n`;
fs.writeFileSync('site/data/version.yaml', yaml);
console.log(`Version: ${pkg.version}`);
