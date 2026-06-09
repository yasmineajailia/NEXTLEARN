const fs = require('fs');
const path = './public/student/self-evaluation.html';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(/<style>[\s\S]*?<\/style>/, '<link rel="stylesheet" href="/student/self-evaluation.css" />');
fs.writeFileSync(path, content);
