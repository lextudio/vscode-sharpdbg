'use strict';

const fs = require('fs');

function detectProjectKind(projectPath) {
  const contents = fs.readFileSync(projectPath, 'utf8');
  return detectProjectKindFromContents(contents, projectPath);
}

function detectProjectKindFromContents(contents, sourceName = 'project file') {
  const projectMatch = contents.match(/<Project\b([^>]*)>/i);
  if (!projectMatch) {
    throw new Error(`Unable to read a Project root element from ${sourceName}`);
  }

  if (/\bSdk\s*=/.test(projectMatch[1])) {
    return 'sdk';
  }

  if (/<Project\b[^>]*\bSdk\s*=/i.test(projectMatch[0])) {
    return 'sdk';
  }

  return 'legacy';
}

module.exports = {
  detectProjectKind,
  detectProjectKindFromContents
};
