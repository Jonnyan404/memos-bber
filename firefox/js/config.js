/**
 * Build-free configuration shared by all three bundles.
 *
 * There is no bundler here: this file is loaded with a plain <script> tag
 * before oper.js, and the identical copy ships in chrome/, edge/ and firefox/.
 * Editing a URL once therefore updates every build.
 */
window.EXT_LINKS = Object.freeze({
  // "Support" entry in the popup header. Keep it an absolute https URL: the
  // entry stays hidden when this is empty or is not a ko-fi.com link, so a
  // typo can never ship a dead button.
  kofi: 'https://ko-fi.com/jonnyan404',
  // Source / issues, shown next to it as a plain icon.
  github: 'https://github.com/Jonnyan404/memos-bber'
})
