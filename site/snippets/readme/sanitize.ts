// #region quick-start
import { sanitize } from '@knead-js/sanitize';

// The default 'basic' policy keeps simple formatting and links, and drops everything else.
export const comment = sanitize(
  '<p onclick="steal()">Read <a href="javascript:steal()">this</a> and <a href="https://example.com">that</a></p><script>steal()</script>',
);
// '<p>Read <a rel="noopener noreferrer">this</a> and <a href="https://example.com" rel="noopener noreferrer">that</a></p>'

// 'strict' keeps the text only.
export const title = sanitize('<h1>Release <em>notes</em></h1>', 'strict');
// 'Release notes'
// #endregion quick-start
